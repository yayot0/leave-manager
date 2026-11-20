/**
 * Helpers for integration tests. Import this only from *.int.test.ts files:
 * it talks to the database configured by setup-integration.ts.
 */
import { prisma } from "../db/prisma.js";
import { signAuthToken } from "../security/jwt.js";
import { AUTH_COOKIE_NAME } from "../modules/auth/cookie.js";
import { parseISODate } from "../domain/dates.js";
import type { LeaveRequestStatus, Role } from "../generated/prisma/enums.js";

export { prisma };

/** "YYYY-MM-DD" -> UTC-midnight Date (throws on invalid input). */
export function d(iso: string): Date {
  const date = parseISODate(iso);
  if (!date) throw new Error(`Invalid test date: ${iso}`);
  return date;
}

const APP_TABLES = [
  // Append-only: its triggers reject UPDATE/DELETE, and TRUNCATE unless the
  // transaction sets app.allow_audit_truncate (resetDb does).
  "hr_audit_logs",
  "request_events",
  "balance_adjustments",
  "leave_requests",
  "holidays",
  "leave_types",
  "users",
  "departments",
];

/** Empties every app table. Refuses to run outside a *_test database. */
export async function resetDb(): Promise<void> {
  const [{ current_database: dbName }] = await prisma.$queryRaw<
    { current_database: string }[]
  >`SELECT current_database()`;
  if (!dbName.endsWith("_test")) {
    throw new Error(`resetDb refused: connected to "${dbName}", not a *_test database.`);
  }
  const tables = APP_TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$transaction(async (tx) => {
    // hr_audit_logs blocks TRUNCATE unless the transaction opts in; the
    // setting is local to this transaction (third argument `true`).
    await tx.$queryRaw`SELECT set_config('app.allow_audit_truncate', 'on', true)`;
    await tx.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  });
}

let userCounter = 0;

export async function createUser(
  overrides: {
    hireDate?: string;
    role?: Role;
    isActive?: boolean;
    email?: string;
    managerId?: string | null;
  } = {},
) {
  userCounter++;
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user${userCounter}-${Date.now()}@test.local`,
      // Tests authenticate by signing a JWT directly, never via password.
      passwordHash: "not-a-real-hash",
      firstName: "Test",
      lastName: `User ${userCounter}`,
      role: overrides.role ?? "EMPLOYEE",
      hireDate: d(overrides.hireDate ?? "2023-02-01"),
      isActive: overrides.isActive ?? true,
      managerId: overrides.managerId ?? null,
    },
  });
}

export async function createLeaveType(
  overrides: {
    code?: string;
    name?: string;
    countsAgainstVacationBalance?: boolean;
    isActive?: boolean;
    maxBusinessDaysPerRequest?: number | null;
  } = {},
) {
  const code = overrides.code ?? `T${++userCounter}`;
  return prisma.leaveType.create({
    data: {
      code,
      name: overrides.name ?? `Tipo ${code}`,
      countsAgainstVacationBalance: overrides.countsAgainstVacationBalance ?? true,
      isActive: overrides.isActive ?? true,
      maxBusinessDaysPerRequest: overrides.maxBusinessDaysPerRequest ?? null,
    },
  });
}

export async function createHoliday(date: string, name = "Festivo") {
  return prisma.holiday.create({ data: { date: d(date), name } });
}

/** Inserts a request directly (bypassing the API) to set up existing state. */
export async function createLeaveRequestRow(opts: {
  requesterId: string;
  leaveTypeId: string;
  start: string;
  end: string;
  businessDays: number;
  status?: LeaveRequestStatus;
  createdAt?: Date;
  /** Who decided it. Only allowed for APPROVED, REJECTED or CANCELLED. */
  deciderId?: string;
  decidedAt?: Date;
  /** The request's copy; defaults to its leave type's current value, as the API does. */
  countsAgainstVacationBalance?: boolean;
}) {
  const status = opts.status ?? "PENDING";
  const countsAgainstVacationBalance =
    opts.countsAgainstVacationBalance ??
    (
      await prisma.leaveType.findUniqueOrThrow({
        where: { id: opts.leaveTypeId },
        select: { countsAgainstVacationBalance: true },
      })
    ).countsAgainstVacationBalance;
  // chk_leave_requests_decision_matches_status: APPROVED/REJECTED need a
  // decider (different from the requester); invent one if the test did not
  // pass it, so every row this helper creates is valid for the database.
  const needsDecision = status === "APPROVED" || status === "REJECTED";
  const deciderId =
    opts.deciderId ?? (needsDecision ? (await createUser({ role: "MANAGER" })).id : undefined);
  return prisma.leaveRequest.create({
    data: {
      requesterId: opts.requesterId,
      leaveTypeId: opts.leaveTypeId,
      countsAgainstVacationBalance,
      startDate: d(opts.start),
      endDate: d(opts.end),
      businessDays: opts.businessDays,
      status,
      ...(deciderId ? { deciderId, decidedAt: opts.decidedAt ?? new Date() } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

export async function createAdjustment(userId: string, days: number, effectiveDate: string) {
  return prisma.balanceAdjustment.create({
    data: { userId, days, reason: "Ajuste de prueba", effectiveDate: d(effectiveDate) },
  });
}

/**
 * A session cookie for the user as it is now: the token carries the user's
 * current passwordChangedAt, like one issued at login. For an id that does
 * not exist it still signs a token (with 0), and requireAuth answers 401.
 */
export async function authCookie(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordChangedAt: true } });
  const token = await signAuthToken(userId, user?.passwordChangedAt ?? new Date(0));
  return `${AUTH_COOKIE_NAME}=${token}`;
}
