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
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

let userCounter = 0;

export async function createUser(
  overrides: { hireDate?: string; role?: Role; isActive?: boolean; email?: string } = {},
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
    },
  });
}

export async function createLeaveType(
  overrides: { code?: string; name?: string; countsAgainstVacationBalance?: boolean; isActive?: boolean } = {},
) {
  const code = overrides.code ?? `T${++userCounter}`;
  return prisma.leaveType.create({
    data: {
      code,
      name: overrides.name ?? `Tipo ${code}`,
      countsAgainstVacationBalance: overrides.countsAgainstVacationBalance ?? true,
      isActive: overrides.isActive ?? true,
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
}) {
  return prisma.leaveRequest.create({
    data: {
      requesterId: opts.requesterId,
      leaveTypeId: opts.leaveTypeId,
      startDate: d(opts.start),
      endDate: d(opts.end),
      businessDays: opts.businessDays,
      status: opts.status ?? "PENDING",
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

export async function createAdjustment(userId: string, days: number, effectiveDate: string) {
  return prisma.balanceAdjustment.create({
    data: { userId, days, reason: "Ajuste de prueba", effectiveDate: d(effectiveDate) },
  });
}

/** Cookie header value that authenticates as `userId`. */
export async function authCookie(userId: string): Promise<string> {
  const token = await signAuthToken(userId);
  return `${AUTH_COOKIE_NAME}=${token}`;
}
