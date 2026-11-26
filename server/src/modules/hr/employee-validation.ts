import type { Prisma } from "../../generated/prisma/client.js";
import type { Role } from "../../generated/prisma/enums.js";
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from "../../errors/AppError.js";
import { toISODate } from "../../domain/dates.js";
import type { DbClient } from "../balance/balance.service.js";
import { withCode } from "./errors.js";

/**
 * Rules of the employee directory, shared by the writes (create, edit,
 * deactivate, reactivate) and their previews, so they never disagree (same
 * idea as new-request-validation.ts). The writes run them AFTER
 * lockEmployeeDirectory: only then are the cross-row reads (chain of
 * managers, active HR count, active reports) safe from write skew.
 */

/** Roles that may have direct reports (decide their requests). */
const MANAGER_ROLES: readonly Role[] = ["MANAGER", "HR"];

/**
 * Inside the transaction (after its locks), the actor must still be an
 * active HR user: requireAuth checked it before, and another HR may have
 * deactivated or demoted it in between. Same answers requireAuth and
 * requireRole would give now: deactivated → 401 (the client ends the
 * session, as when deciding a request), no longer HR → 403.
 */
export async function assertActorIsActiveHr(tx: Prisma.TransactionClient, actorId: string): Promise<void> {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true } });
  if (!actor?.isActive) {
    throw new UnauthorizedError();
  }
  if (actor.role !== "HR") {
    throw new ForbiddenError("Ya no tienes permisos de Recursos Humanos");
  }
}

/** Latest hire date accepted: one year after today (registered before the first day). */
export function assertHireDateInRange(hireDate: Date, today: Date): void {
  const latest = new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate()));
  if (hireDate.getTime() > latest.getTime()) {
    throw withCode(
      new BadRequestError(`La fecha de ingreso no puede ser posterior al ${toISODate(latest)}`),
      "HIRE_DATE_OUT_OF_RANGE",
    );
  }
}

const notEligible = (message: string) => withCode(new ConflictError(message), "MANAGER_NOT_ELIGIBLE");

/**
 * The manager must exist, be active and be MANAGER or HR; when the employee
 * already exists (`employeeId`), it cannot be the employee or anyone below
 * them. The manager's row is not locked: under the directory lock nobody
 * can change its role or isActive meanwhile.
 */
export async function assertManagerEligible(db: DbClient, employeeId: string | null, managerId: string): Promise<void> {
  if (employeeId !== null && managerId === employeeId) {
    throw withCode(new BadRequestError("Una persona no puede ser su propio jefe"), "MANAGER_IS_SELF");
  }
  const manager = await db.user.findUnique({ where: { id: managerId }, select: { isActive: true, role: true } });
  if (!manager) {
    throw notEligible("El jefe elegido no existe");
  }
  if (!manager.isActive) {
    throw notEligible("El jefe elegido está dado de baja");
  }
  if (!MANAGER_ROLES.includes(manager.role)) {
    throw notEligible("El jefe debe tener rol de Jefe de área o de Recursos Humanos");
  }
  if (employeeId !== null && (await reportsTo(db, managerId, employeeId))) {
    throw withCode(
      new ConflictError("El jefe elegido reporta (directa o indirectamente) a esta persona: se formaría un ciclo"),
      "MANAGER_CYCLE",
    );
  }
}

/** Defensive bound for the walk up the chain (a real hierarchy is a few levels deep). */
const MAX_CHAIN_DEPTH = 1000;

/**
 * Whether `employeeId` is `startId` or one of its managers, walking up
 * manager_id. Inactive users count too: a cycle through an inactive user
 * would come back when they are reactivated. UNION (not UNION ALL) drops
 * repeated rows, so even a cycle left by old data ends the recursion; the
 * depth bound is a second safety net.
 */
async function reportsTo(db: DbClient, startId: string, employeeId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ found: boolean }[]>`
    WITH RECURSIVE chain(id, manager_id, depth) AS (
      SELECT id, manager_id, 1 FROM users WHERE id = ${startId}
      UNION
      SELECT u.id, u.manager_id, c.depth + 1
      FROM users u JOIN chain c ON u.id = c.manager_id
      WHERE c.depth < ${MAX_CHAIN_DEPTH}
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${employeeId}) AS found`;
  return rows[0]?.found === true;
}

export async function countActiveReports(db: DbClient, employeeId: string): Promise<number> {
  return db.user.count({ where: { managerId: employeeId, isActive: true } });
}

/** Active HR users other than `employeeId`. */
async function countOtherActiveHr(db: DbClient, employeeId: string): Promise<number> {
  return db.user.count({ where: { role: "HR", isActive: true, id: { not: employeeId } } });
}

const lastActiveHr = (message: string) => withCode(new ConflictError(message), "LAST_ACTIVE_HR");

/**
 * Changing the role of an active employee: an EMPLOYEE cannot have active
 * direct reports (they must be reassigned first), and there must always be
 * at least one active HR user.
 */
export async function assertRoleChangeAllowed(
  db: DbClient,
  employee: { id: string; role: Role; isActive: boolean },
  nextRole: Role,
): Promise<void> {
  if (nextRole === employee.role) return;
  if (!MANAGER_ROLES.includes(nextRole) && (await countActiveReports(db, employee.id)) > 0) {
    throw withCode(
      new ConflictError("Tiene personas activas a su cargo: reasígnalas a otro jefe antes de cambiarle el rol a Empleado"),
      "HAS_ACTIVE_REPORTS",
    );
  }
  if (employee.role === "HR" && employee.isActive && (await countOtherActiveHr(db, employee.id)) === 0) {
    throw lastActiveHr("Es la única persona activa de Recursos Humanos: debe quedar al menos una");
  }
}

// ---------- Hire date ----------

export type HireDateProblem = { code: "HIRE_DATE_AFTER_REQUESTS"; message: string; earliestRequestStart: string };

/**
 * A new hireDate cannot fall after the start of an active (PENDING or
 * APPROVED) request: the request would start before the person worked
 * here, and its balance period (that of its startDate) would not exist.
 */
export async function evaluateHireDateChange(
  db: DbClient,
  employeeId: string,
  hireDate: Date,
): Promise<HireDateProblem | null> {
  const earliest = await db.leaveRequest.findFirst({
    where: { requesterId: employeeId, status: { in: ["PENDING", "APPROVED"] }, startDate: { lt: hireDate } },
    orderBy: { startDate: "asc" },
    select: { startDate: true },
  });
  if (!earliest) return null;
  const start = toISODate(earliest.startDate);
  return {
    code: "HIRE_DATE_AFTER_REQUESTS",
    message: `Tiene una solicitud activa que empieza el ${start}: la fecha de ingreso no puede ser posterior`,
    earliestRequestStart: start,
  };
}

export function hireDateProblemToError(problem: HireDateProblem): ConflictError {
  const error = withCode(new ConflictError(problem.message), problem.code);
  error.data = { earliestRequestStart: problem.earliestRequestStart };
  return error;
}

// ---------- Deactivation ----------

const deactivationRequestSelect = {
  id: true,
  startDate: true,
  endDate: true,
  businessDays: true,
  status: true,
  leaveType: { select: { name: true } },
} satisfies Prisma.LeaveRequestSelect;

type DeactivationRequestRow = Prisma.LeaveRequestGetPayload<{ select: typeof deactivationRequestSelect }>;

export interface DeactivationPlan {
  activeReports: { id: string; firstName: string; lastName: string }[];
  /** PENDING requests that already started: deactivation is blocked until someone decides them. */
  overdue: DeactivationRequestRow[];
  /** Cancelled by the deactivation: PENDING and APPROVED that start after today. */
  toCancel: DeactivationRequestRow[];
  /** APPROVED that already started (in progress or finished in the period): never touched. */
  startedApproved: number;
  /**
   * Of those, the ones still running after today: their remaining days keep
   * counting as taken although the employee will no longer enjoy them, so
   * the final settlement (Art. 79 LFT) may need a balance adjustment.
   */
  approvedRunningPastToday: number;
  /** The employee is the only active HR user. */
  isLastActiveHr: boolean;
}

/**
 * What deactivating the employee would do, as of `today` (APP_TIMEZONE).
 * The preview shows it and the write recomputes it under the locks.
 * - APPROVED that already started stay as they are: those days were taken,
 *   the state machine forbids cancelling them, and the final settlement
 *   (Art. 79 LFT pays unused vacation days) needs the real record.
 * - PENDING that already started block it: the employee may have been
 *   absent with verbal approval, so cancelling them would falsify the
 *   record (they are never decided automatically; see CLAUDE.md).
 */
export async function planDeactivation(
  db: DbClient,
  employee: { id: string; role: Role },
  today: Date,
): Promise<DeactivationPlan> {
  // Sequential: inside a transaction `db` is a single connection.
  const activeReports = await db.user.findMany({
    where: { managerId: employee.id, isActive: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    select: { id: true, firstName: true, lastName: true },
  });
  const requests = await db.leaveRequest.findMany({
    where: { requesterId: employee.id, status: { in: ["PENDING", "APPROVED"] } },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
    select: deactivationRequestSelect,
  });
  const started = (row: DeactivationRequestRow) => row.startDate.getTime() <= today.getTime();
  const isLastActiveHr = employee.role === "HR" && (await countOtherActiveHr(db, employee.id)) === 0;

  return {
    activeReports,
    overdue: requests.filter((row) => row.status === "PENDING" && started(row)),
    toCancel: requests.filter((row) => !started(row)),
    startedApproved: requests.filter((row) => row.status === "APPROVED" && started(row)).length,
    approvedRunningPastToday: requests.filter(
      (row) => row.status === "APPROVED" && started(row) && row.endDate.getTime() > today.getTime(),
    ).length,
    isLastActiveHr,
  };
}

export function serializeDeactivationRequest(row: DeactivationRequestRow) {
  return {
    id: row.id,
    startDate: toISODate(row.startDate),
    endDate: toISODate(row.endDate),
    businessDays: row.businessDays,
    status: row.status,
    leaveType: row.leaveType,
  };
}

/** The first rule the plan breaks, as the error the write throws. */
export function deactivationBlocker(plan: DeactivationPlan): ConflictError | null {
  if (plan.activeReports.length > 0) {
    return withCode(
      new ConflictError("Tiene personas activas a su cargo: reasígnalas a otro jefe antes de darle de baja"),
      "HAS_ACTIVE_REPORTS",
    );
  }
  if (plan.isLastActiveHr) {
    return lastActiveHr("Es la única persona activa de Recursos Humanos: debe quedar al menos una");
  }
  if (plan.overdue.length > 0) {
    const error = withCode(
      new ConflictError(
        "Tiene solicitudes pendientes que ya empezaron: su jefe (o RH, si no tiene jefe activo) debe aprobarlas o rechazarlas antes de la baja",
      ),
      "HAS_OVERDUE_PENDING_REQUESTS",
    );
    error.data = { requests: plan.overdue.map(serializeDeactivationRequest) };
    return error;
  }
  return null;
}
