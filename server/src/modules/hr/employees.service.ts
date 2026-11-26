import { prisma } from "../../db/prisma.js";
import { lockEmployeeDirectory, lockLeaveRequest, lockUser, lockUserForWrite } from "../../db/locks.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../db/pg-errors.js";
import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { todayInTimeZone, toISODate } from "../../domain/dates.js";
import { transition } from "../../domain/leave-request-state.js";
import type { VacationBalance } from "../../domain/vacation.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../../errors/AppError.js";
import { hashPassword } from "../../security/password.js";
import { generateTemporaryPassword } from "../../security/temporary-password.js";
import { nextPasswordChangedAt } from "../auth/auth.service.js";
import { getVacationBalance, type DbClient } from "../balance/balance.service.js";
import { recordHrAudit, type AuditSnapshot } from "./audit.js";
import { withCode } from "./errors.js";
import {
  assertActorIsActiveHr,
  assertHireDateInRange,
  assertManagerEligible,
  assertRoleChangeAllowed,
  deactivationBlocker,
  evaluateHireDateChange,
  hireDateProblemToError,
  planDeactivation,
  serializeDeactivationRequest,
} from "./employee-validation.js";
import type { CreateEmployeeInput, EmployeesQuery, UpdateEmployeeInput } from "./hr.schemas.js";

/**
 * The only fields a PASSWORD_RESET entry records (the database CHECK
 * chk_hr_audit_logs_password_reset_shape accepts exactly these two): never
 * the password, its hash or anything else about the user.
 */
function passwordAuditSnapshot(user: { mustChangePassword: boolean; passwordChangedAt: Date }): AuditSnapshot {
  return {
    mustChangePassword: user.mustChangePassword,
    passwordChangedAt: user.passwordChangedAt.toISOString(),
  };
}

export interface PasswordResetResult {
  /** Shown to HR once, in this response; only its hash is stored. */
  temporaryPassword: string;
  user: { id: string; email: string; firstName: string; lastName: string };
}

/**
 * HR gives an employee a new temporary password: only its hash is stored,
 * the employee must replace it on the next login (mustChangePassword), and
 * every session of the employee ends (passwordChangedAt changes). The audit
 * entry says that a reset happened, without the secret.
 */
export async function resetEmployeePassword(actorId: string, employeeId: string): Promise<PasswordResetResult> {
  // HR would learn its own new password and skip the current-password
  // check (and its rate limit): its own password is changed in "Mi cuenta".
  if (actorId === employeeId) {
    throw withCode(
      new ForbiddenError("No puedes restablecer tu propia contraseña; cámbiala desde Mi cuenta"),
      "CANNOT_RESET_OWN_PASSWORD",
    );
  }

  // Generated and hashed before the transaction: argon2 is slow and no
  // lock should be held meanwhile.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const select = {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    isActive: true,
    mustChangePassword: true,
    passwordChangedAt: true,
  } as const;

  const user = await prisma.$transaction(async (tx) => {
    await lockUser(tx, employeeId);
    // The actor again, under the employee's lock: HR deactivated or demoted
    // since requireAuth must not walk away with another account's password.
    // A read, not the directory lock: a reset changes no role, state or
    // manager, so it races with none of the directory's cross-row rules.
    await assertActorIsActiveHr(tx, actorId);
    const before = await tx.user.findUnique({ where: { id: employeeId }, select });
    if (!before) throw new NotFoundError("Empleado no encontrado");
    if (!before.isActive) {
      throw withCode(
        new ConflictError("El empleado está inactivo: no puede iniciar sesión"),
        "EMPLOYEE_INACTIVE",
      );
    }

    const after = await tx.user.update({
      where: { id: employeeId },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: nextPasswordChangedAt(before.passwordChangedAt),
      },
      select,
    });

    await recordHrAudit(tx, {
      actorId,
      entityType: "EMPLOYEE",
      entityId: employeeId,
      action: "PASSWORD_RESET",
      before: passwordAuditSnapshot(before),
      after: passwordAuditSnapshot(after),
    });

    return after;
  });

  return {
    temporaryPassword,
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
  };
}

// ---------- Employee administration (RH-B2) ----------

const EMPLOYEE_NOT_FOUND = "Empleado no encontrado";
const DUPLICATE_EMAIL = "Ya existe una persona con ese correo";
const DEPARTMENT_NOT_FOUND = "El departamento elegido ya no existe";
/** Note of the CANCELLED event of each request cancelled by a deactivation. */
export const DEACTIVATION_CANCEL_NOTE = "Cancelada por la baja del empleado";

const personSelect = { id: true, firstName: true, lastName: true } as const;

/**
 * Every column the HR screens and the audit log use: a WHITELIST, so
 * passwordHash (and passwordChangedAt) never leave the database here.
 */
const employeeSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  hireDate: true,
  isActive: true,
  mustChangePassword: true,
  departmentId: true,
  managerId: true,
  createdAt: true,
  updatedAt: true,
  department: { select: { id: true, name: true } },
  manager: { select: personSelect },
} satisfies Prisma.UserSelect;

type EmployeeRow = Prisma.UserGetPayload<{ select: typeof employeeSelect }>;

/** What the list, create, edit and state changes return. Dates as ISO; hireDate as "YYYY-MM-DD". */
function serializeEmployee(row: EmployeeRow) {
  return { ...row, hireDate: toISODate(row.hireDate) };
}

/**
 * The audit snapshot of an employee: a whitelist of plain fields (never the
 * password, its hash or passwordChangedAt). CHECK chk_hr_audit_logs_no_secrets
 * rejects any entry with a secret key, as a last line of defense.
 */
function employeeAuditSnapshot(row: EmployeeRow): AuditSnapshot {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    departmentId: row.departmentId,
    managerId: row.managerId,
    hireDate: toISODate(row.hireDate),
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
  };
}

function serializeBalance(balance: VacationBalance) {
  return {
    ...balance,
    period: { start: toISODate(balance.period.start), end: toISODate(balance.period.end) },
  };
}

const employeeNotFound = () => new NotFoundError(EMPLOYEE_NOT_FOUND);
const duplicateEmail = () => withCode(new ConflictError(DUPLICATE_EMAIL), "DUPLICATE_EMAIL");
const departmentNotFound = () => withCode(new ConflictError(DEPARTMENT_NOT_FOUND), "DEPARTMENT_NOT_FOUND");

function staleData(): ConflictError {
  return withCode(
    new ConflictError("Alguien más modificó a este empleado mientras lo editabas; vuelve a abrirlo para ver lo actual"),
    "STALE_DATA",
  );
}

/** Optimistic concurrency, as in updateLeaveType. */
function assertNotStale(expectedUpdatedAt: string | undefined, current: { updatedAt: Date }): void {
  if (expectedUpdatedAt !== undefined && new Date(expectedUpdatedAt).getTime() !== current.updatedAt.getTime()) {
    throw staleData();
  }
}

/** Maps the database's last line of defense to the same errors as the pre-checks. */
function mapEmployeeWriteError(err: unknown): unknown {
  // Only the email's unique index: another UNIQUE added to users later must
  // not be reported as a duplicate email (same idea as the FK below).
  if (isUniqueViolation(err, "users_email_key")) return duplicateEmail();
  if (isForeignKeyViolation(err, "users_department_id_fkey")) return departmentNotFound();
  return err;
}

async function assertDepartmentExists(db: DbClient, departmentId: string): Promise<void> {
  if (!(await db.department.findUnique({ where: { id: departmentId }, select: { id: true } }))) {
    throw departmentNotFound();
  }
}

async function assertEmailFree(db: DbClient, email: string, exceptId?: string): Promise<void> {
  const owner = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (owner && owner.id !== exceptId) throw duplicateEmail();
}

// ---------- Reads ----------

/** Escapes LIKE's wildcards with "\\", Postgres' default escape character (the escape itself first). */
function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * GET /api/hr/employees — offset pagination (HR wants "page 3 of 8" and a
 * shareable ?page=3 URL; the table holds hundreds of rows, not millions).
 * The order ends with `id`, so equal names never swap between pages.
 * Each word of `q` must appear in the first name, last name or email
 * (ILIKE via `contains`). `contains` does NOT escape the LIKE wildcards:
 * escapeLike does, so "%" or "_" match themselves (not "anything").
 */
export async function listEmployees(query: EmployeesQuery) {
  const words = (query.q ?? "").split(/\s+/).filter(Boolean).slice(0, 5).map(escapeLike);
  const where: Prisma.UserWhereInput = {
    AND: [
      query.status === "all" ? {} : { isActive: query.status === "active" },
      query.role ? { role: query.role } : {},
      query.departmentId ? { departmentId: query.departmentId } : {},
      ...words.map((word) => ({
        OR: [
          { firstName: { contains: word, mode: "insensitive" as const } },
          { lastName: { contains: word, mode: "insensitive" as const } },
          { email: { contains: word, mode: "insensitive" as const } },
        ],
      })),
    ],
  };
  // One transaction: the count and the page come from the same snapshot.
  const [total, rows] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: employeeSelect,
    }),
  ]);
  return {
    employees: rows.map(serializeEmployee),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Active MANAGER and HR users: who can be picked as a manager. */
export async function listManagerOptions() {
  return prisma.user.findMany({
    where: { isActive: true, role: { in: ["MANAGER", "HR"] } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    select: { ...personSelect, role: true, department: { select: { id: true, name: true } } },
  });
}

/**
 * GET /api/hr/employees/:id — the employee, their manager and direct
 * reports, their current balance, and what `actorId` may do with them.
 * `permissions` carries the segregation-of-duties rules, so the client never
 * re-implements them (HR never changes its own role, state, hire date or
 * manager).
 */
export async function getEmployeeDetail(actorId: string, id: string) {
  const row = await prisma.user.findUnique({
    where: { id },
    select: {
      ...employeeSelect,
      manager: { select: { ...personSelect, role: true, isActive: true } },
      directReports: {
        orderBy: [{ isActive: "desc" }, { lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
        select: { ...personSelect, role: true, isActive: true },
      },
    },
  });
  if (!row) throw employeeNotFound();

  const today = todayInTimeZone(env.APP_TIMEZONE);
  const balance = await getVacationBalance(prisma, row, today);
  const isSelf = actorId === row.id;
  return {
    ...row,
    hireDate: toISODate(row.hireDate),
    balance: { ...serializeBalance(balance), asOf: toISODate(today) },
    permissions: {
      canEditRole: !isSelf,
      canEditHireDate: !isSelf,
      canEditManager: !isSelf,
      canDeactivate: row.isActive && !isSelf,
      canReactivate: !row.isActive,
      canResetPassword: row.isActive && !isSelf,
    },
  };
}

/**
 * GET /api/hr/employees/:id/hire-date-impact — the current balance with the
 * hire date as it is and as it would be. Same "today" and same function as
 * Mi saldo; `problem` is the same check the PATCH runs.
 */
export async function getHireDateImpact(id: string, hireDate: Date) {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, hireDate: true } });
  if (!user) throw employeeNotFound();
  const today = todayInTimeZone(env.APP_TIMEZONE);
  assertHireDateInRange(hireDate, today);
  const current = await getVacationBalance(prisma, user, today);
  const proposed = await getVacationBalance(prisma, { id, hireDate }, today);
  return {
    asOf: toISODate(today),
    current: serializeBalance(current),
    proposed: serializeBalance(proposed),
    problem: await evaluateHireDateChange(prisma, id, hireDate),
  };
}

/**
 * GET /api/hr/employees/:id/deactivation-impact — what deactivating would
 * do, computed by the same function the write runs under its locks.
 */
export async function getDeactivationImpact(actorId: string, id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, isActive: true } });
  if (!user) throw employeeNotFound();
  if (!user.isActive) {
    throw withCode(new ConflictError("El empleado ya está dado de baja"), "EMPLOYEE_INACTIVE");
  }
  const plan = await planDeactivation(prisma, user, todayInTimeZone(env.APP_TIMEZONE));
  const blocker = actorId === id ? "CANNOT_DEACTIVATE_SELF" : (deactivationBlocker(plan)?.code ?? null);
  return {
    activeReports: plan.activeReports,
    overdueRequests: plan.overdue.map(serializeDeactivationRequest),
    toCancel: {
      pending: plan.toCancel.filter((row) => row.status === "PENDING").length,
      approved: plan.toCancel.filter((row) => row.status === "APPROVED").length,
    },
    startedApproved: plan.startedApproved,
    approvedRunningPastToday: plan.approvedRunningPastToday,
    isLastActiveHr: plan.isLastActiveHr,
    /** null = it can be deactivated; otherwise the code the POST would answer. */
    blocker,
  };
}

// ---------- Writes ----------
//
// Every write takes lockEmployeeDirectory FIRST (see locks.ts: it rules out
// cycles and the other cross-row races), then re-checks that the actor is
// still an active HR user, then locks the employee's row. Never run them
// with an isolation level above READ COMMITTED: the snapshot would be taken
// before waiting for the lock and every check would read stale data.

export interface EmployeeWithPassword {
  /** Shown to HR once, in this response; only its hash is stored. */
  temporaryPassword: string;
  employee: ReturnType<typeof serializeEmployee>;
}

/**
 * HR registers an employee with a temporary password (generated, shown
 * once, stored only as a hash): mustChangePassword is set EXPLICITLY, since
 * the column defaults to false.
 */
export async function createEmployee(actorId: string, input: CreateEmployeeInput): Promise<EmployeeWithPassword> {
  assertHireDateInRange(input.hireDate, todayInTimeZone(env.APP_TIMEZONE));
  // Outside the transaction: argon2 is slow and no lock should wait for it.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    const employee = await prisma.$transaction(async (tx) => {
      await lockEmployeeDirectory(tx);
      await assertActorIsActiveHr(tx, actorId);
      await assertEmailFree(tx, input.email);
      await assertDepartmentExists(tx, input.departmentId);
      if (input.managerId !== null) {
        await assertManagerEligible(tx, null, input.managerId);
      }
      const created = await tx.user.create({
        data: { ...input, passwordHash, mustChangePassword: true },
        select: employeeSelect,
      });
      await recordHrAudit(tx, {
        actorId,
        entityType: "EMPLOYEE",
        entityId: created.id,
        action: "CREATED",
        before: null,
        after: employeeAuditSnapshot(created),
      });
      return created;
    });
    return { temporaryPassword, employee: serializeEmployee(employee) };
  } catch (err) {
    throw mapEmployeeWriteError(err);
  }
}

const EDITABLE_FIELDS = ["email", "firstName", "lastName", "role", "departmentId", "managerId", "hireDate"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

function fieldChanged(field: EditableField, input: UpdateEmployeeInput, current: EmployeeRow): boolean {
  if (field === "hireDate") {
    return input.hireDate !== undefined && input.hireDate.getTime() !== current.hireDate.getTime();
  }
  const value = input[field];
  return value !== undefined && value !== current[field];
}

/**
 * Segregation of duties: HR never changes its own data that gives it an
 * advantage (its role, its hire date — more vacation days — or its
 * manager — who approves its requests). Another HR user can.
 */
function assertNotOwnAdvantage(actorId: string, id: string, changed: readonly EditableField[]): void {
  if (actorId !== id) return;
  if (changed.includes("role")) {
    throw withCode(new ForbiddenError("No puedes cambiar tu propio rol; pídeselo a otra persona de RH"), "CANNOT_CHANGE_OWN_ROLE");
  }
  if (changed.includes("hireDate")) {
    throw withCode(
      new ForbiddenError("No puedes cambiar tu propia fecha de ingreso; pídeselo a otra persona de RH"),
      "CANNOT_EDIT_OWN_HIRE_DATE",
    );
  }
  if (changed.includes("managerId")) {
    throw withCode(new ForbiddenError("No puedes cambiar tu propio jefe; pídeselo a otra persona de RH"), "CANNOT_CHANGE_OWN_MANAGER");
  }
}

/**
 * Edits an employee: only the fields that changed (a concurrent edit of
 * another field is not overwritten), with optimistic concurrency. A PATCH
 * with no real difference writes and logs nothing.
 */
export async function updateEmployee(actorId: string, id: string, input: UpdateEmployeeInput) {
  if (input.hireDate !== undefined) {
    assertHireDateInRange(input.hireDate, todayInTimeZone(env.APP_TIMEZONE));
  }
  try {
    const row = await prisma.$transaction(async (tx) => {
      await lockEmployeeDirectory(tx);
      await assertActorIsActiveHr(tx, actorId);
      await lockUser(tx, id);
      const current = await tx.user.findUnique({ where: { id }, select: employeeSelect });
      if (!current) throw employeeNotFound();
      assertNotStale(input.expectedUpdatedAt, current);

      const changed = EDITABLE_FIELDS.filter((field) => fieldChanged(field, input, current));
      if (changed.length === 0) return current;
      assertNotOwnAdvantage(actorId, id, changed);

      if (changed.includes("email") && input.email !== undefined) await assertEmailFree(tx, input.email, id);
      if (changed.includes("departmentId") && input.departmentId !== undefined) {
        await assertDepartmentExists(tx, input.departmentId);
      }
      if (changed.includes("managerId") && input.managerId) {
        await assertManagerEligible(tx, id, input.managerId);
      }
      if (changed.includes("role") && input.role !== undefined) {
        await assertRoleChangeAllowed(tx, current, input.role);
      }
      if (changed.includes("hireDate") && input.hireDate !== undefined) {
        const problem = await evaluateHireDateChange(tx, id, input.hireDate);
        if (problem) throw hireDateProblemToError(problem);
      }

      // Only the changed fields, each with its own type.
      const data: Prisma.UserUncheckedUpdateInput = {
        ...(changed.includes("email") ? { email: input.email } : {}),
        ...(changed.includes("firstName") ? { firstName: input.firstName } : {}),
        ...(changed.includes("lastName") ? { lastName: input.lastName } : {}),
        ...(changed.includes("role") ? { role: input.role } : {}),
        ...(changed.includes("departmentId") ? { departmentId: input.departmentId } : {}),
        ...(changed.includes("managerId") ? { managerId: input.managerId } : {}),
        ...(changed.includes("hireDate") ? { hireDate: input.hireDate } : {}),
      };
      const updated = await tx.user.update({ where: { id }, data, select: employeeSelect });
      await recordHrAudit(tx, {
        actorId,
        entityType: "EMPLOYEE",
        entityId: id,
        action: "UPDATED",
        before: employeeAuditSnapshot(current),
        after: employeeAuditSnapshot(updated),
      });
      return updated;
    });
    return serializeEmployee(row);
  } catch (err) {
    throw mapEmployeeWriteError(err);
  }
}

/**
 * Deactivates an employee. Refused with active direct reports, as the last
 * active HR, or with PENDING requests that already started (someone must
 * decide them: see planDeactivation). In the same transaction, every
 * PENDING or APPROVED request that starts after today is cancelled, each
 * with its CANCELLED event signed by HR (decider_id is not touched). Their
 * sessions end by themselves: requireAuth rejects inactive users.
 */
export async function deactivateEmployee(actorId: string, id: string, expectedUpdatedAt: string | undefined) {
  if (actorId === id) {
    throw withCode(new ForbiddenError("No puedes darte de baja a ti misma; pídeselo a otra persona de RH"), "CANNOT_DEACTIVATE_SELF");
  }
  const result = await prisma.$transaction(async (tx) => {
    await lockEmployeeDirectory(tx);
    await assertActorIsActiveHr(tx, actorId);
    // The same lock every write on the employee's requests takes (create,
    // cancel, decide): they wait for this transaction, and then see the
    // employee inactive and refuse (lockUserForWrite).
    if (!(await lockUserForWrite(tx, id))) throw employeeNotFound();
    const current = await tx.user.findUnique({ where: { id }, select: employeeSelect });
    if (!current) throw employeeNotFound();
    if (!current.isActive) {
      throw withCode(new ConflictError("El empleado ya está dado de baja"), "EMPLOYEE_INACTIVE");
    }
    assertNotStale(expectedUpdatedAt, current);

    // After waiting for the locks, so a wait across midnight uses the right day.
    const today = todayInTimeZone(env.APP_TIMEZONE);
    const plan = await planDeactivation(tx, current, today);
    const blocker = deactivationBlocker(plan);
    if (blocker) throw blocker;

    for (const request of plan.toCancel) {
      await lockLeaveRequest(tx, request.id);
      // Same state machine as the employee's own cancel (startDate > today).
      const next = transition(request.status, "CANCEL", { startDate: request.startDate, today });
      if (!next.ok) throw new ConflictError(next.reason);
      const updated = await tx.leaveRequest.updateMany({
        where: { id: request.id, status: request.status },
        data: { status: next.next },
      });
      if (updated.count !== 1) {
        throw new ConflictError("Una solicitud del empleado cambió de estado; vuelve a intentarlo");
      }
      await tx.requestEvent.create({
        data: { leaveRequestId: request.id, actorId, action: "CANCELLED", note: DEACTIVATION_CANCEL_NOTE },
      });
    }

    const updated = await tx.user.update({ where: { id }, data: { isActive: false }, select: employeeSelect });
    await recordHrAudit(tx, {
      actorId,
      entityType: "EMPLOYEE",
      entityId: id,
      action: "DEACTIVATED",
      before: employeeAuditSnapshot(current),
      after: employeeAuditSnapshot(updated),
    });
    return { employee: updated, cancelledRequests: plan.toCancel.length };
  });
  return { employee: serializeEmployee(result.employee), cancelledRequests: result.cancelledRequests };
}

/**
 * Reactivates an employee with a NEW temporary password (the old one may
 * have been compromised while the account was inactive), shown once. Their
 * manager must still be eligible; otherwise HR edits it first.
 */
export async function reactivateEmployee(
  actorId: string,
  id: string,
  expectedUpdatedAt: string | undefined,
): Promise<EmployeeWithPassword> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const row = await prisma.$transaction(async (tx) => {
    await lockEmployeeDirectory(tx);
    await assertActorIsActiveHr(tx, actorId);
    await lockUser(tx, id);
    const current = await tx.user.findUnique({
      where: { id },
      select: { ...employeeSelect, passwordChangedAt: true },
    });
    if (!current) throw employeeNotFound();
    if (current.isActive) {
      throw withCode(new ConflictError("El empleado ya está activo"), "EMPLOYEE_ALREADY_ACTIVE");
    }
    assertNotStale(expectedUpdatedAt, current);
    if (current.managerId !== null) {
      try {
        await assertManagerEligible(tx, id, current.managerId);
      } catch (err) {
        // Same code, with the way out: edit the (inactive) employee first.
        if (err instanceof AppError) err.message = `${err.message}. Cambia su jefe antes de reactivarlo.`;
        throw err;
      }
    }

    const updated = await tx.user.update({
      where: { id },
      data: {
        isActive: true,
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: nextPasswordChangedAt(current.passwordChangedAt),
      },
      select: employeeSelect,
    });
    await recordHrAudit(tx, {
      actorId,
      entityType: "EMPLOYEE",
      entityId: id,
      action: "REACTIVATED",
      before: employeeAuditSnapshot(current),
      after: employeeAuditSnapshot(updated),
    });
    return updated;
  });
  return { temporaryPassword, employee: serializeEmployee(row) };
}
