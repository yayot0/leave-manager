import { prisma } from "../../db/prisma.js";
import { lockLeaveType } from "../../db/locks.js";
import { isUniqueViolation } from "../../db/pg-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { HrAuditAction } from "../../generated/prisma/enums.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../errors/AppError.js";
import { recordHrAudit, type AuditSnapshot } from "./audit.js";
import { withCode } from "./errors.js";
import type { CreateLeaveTypeInput, UpdateLeaveTypeInput } from "./hr.schemas.js";

const NOT_FOUND = "Tipo de permiso no encontrado";
const DUPLICATE_NAME = "Ya existe un tipo de permiso con ese nombre";
const DUPLICATE_CODE = "Ya existe un tipo de permiso con ese código";

const leaveTypeSelect = {
  id: true,
  code: true,
  name: true,
  countsAgainstVacationBalance: true,
  maxBusinessDaysPerRequest: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { leaveRequests: true } },
} satisfies Prisma.LeaveTypeSelect;

type LeaveTypeRow = Prisma.LeaveTypeGetPayload<{ select: typeof leaveTypeSelect }>;

/** The fields HR may change. `code` is fixed at creation. */
const EDITABLE_FIELDS = ["name", "countsAgainstVacationBalance", "maxBusinessDaysPerRequest", "isActive"] as const;

function serialize(row: LeaveTypeRow) {
  const { _count, ...rest } = row;
  return { ...rest, requestCount: _count.leaveRequests };
}

function snapshot(row: LeaveTypeRow): AuditSnapshot {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    countsAgainstVacationBalance: row.countsAgainstVacationBalance,
    maxBusinessDaysPerRequest: row.maxBusinessDaysPerRequest,
    isActive: row.isActive,
  };
}

/** Same rule as uq_leave_types_name_lower; see nameTaken in departments.service.ts. */
async function nameTaken(tx: Prisma.TransactionClient, name: string, exceptId?: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM leave_types WHERE lower(name) = lower(${name}) AND id <> ${exceptId ?? ""} LIMIT 1`;
  return rows.length > 0;
}

const duplicateName = () => withCode(new ConflictError(DUPLICATE_NAME), "DUPLICATE_NAME");
const duplicateCode = () => withCode(new ConflictError(DUPLICATE_CODE), "DUPLICATE_CODE");

/** Art. 78 LFT (2023 reform): the worker may take at least 12 continuous vacation days. */
export const LFT_MIN_CONTINUOUS_VACATION_DAYS = 12;

/**
 * A type that counts against vacations cannot cap a request below the 12
 * continuous days the law guarantees: the balance already bounds those
 * requests, so their only valid limits are "none" or >= 12. Checked on the
 * RESULTING type (current row merged with the change), since a PATCH may
 * change just one of the two fields.
 */
function assertLftMinimum(type: { countsAgainstVacationBalance: boolean; maxBusinessDaysPerRequest: number | null }) {
  const max = type.maxBusinessDaysPerRequest;
  if (type.countsAgainstVacationBalance && max !== null && max < LFT_MIN_CONTINUOUS_VACATION_DAYS) {
    throw withCode(
      new BadRequestError(
        `Un tipo que descuenta vacaciones no puede limitar las solicitudes a menos de ` +
          `${LFT_MIN_CONTINUOUS_VACATION_DAYS} días hábiles: el Art. 78 de la LFT garantiza al menos ` +
          `${LFT_MIN_CONTINUOUS_VACATION_DAYS} días continuos. Déjalo sin límite o usa ${LFT_MIN_CONTINUOUS_VACATION_DAYS} o más.`,
      ),
      "LIMIT_BELOW_LFT_MINIMUM",
    );
  }
}

/** All leave types, inactive ones included (the public catalog only has active ones). */
export async function listLeaveTypesForHr() {
  const rows = await prisma.leaveType.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: leaveTypeSelect,
  });
  return rows.map(serialize);
}

export async function createLeaveType(actorId: string, input: CreateLeaveTypeInput) {
  try {
    assertLftMinimum(input);
    return await prisma.$transaction(async (tx) => {
      if (await tx.leaveType.findUnique({ where: { code: input.code }, select: { id: true } })) {
        throw duplicateCode();
      }
      if (await nameTaken(tx, input.name)) {
        throw duplicateName();
      }
      const created = await tx.leaveType.create({ data: input, select: leaveTypeSelect });
      await recordHrAudit(tx, {
        actorId,
        entityType: "LEAVE_TYPE",
        entityId: created.id,
        action: "CREATED",
        before: null,
        after: snapshot(created),
      });
      return serialize(created);
    });
  } catch (err) {
    // A concurrent create won the race past the pre-checks: tell which one.
    if (isUniqueViolation(err)) {
      const codeTaken = await prisma.leaveType.findUnique({ where: { code: input.code }, select: { id: true } });
      throw codeTaken ? duplicateCode() : duplicateName();
    }
    throw err;
  }
}

/**
 * Only deactivating or reactivating gets its own action in the log; any
 * other change (even together with isActive) is UPDATED.
 */
function auditAction(changed: readonly string[], isActive: boolean): HrAuditAction {
  if (changed.length === 1 && changed[0] === "isActive") {
    return isActive ? "REACTIVATED" : "DEACTIVATED";
  }
  return "UPDATED";
}

/**
 * Edits a leave type. Every change applies only to NEW requests: each
 * request keeps its own copy of countsAgainstVacationBalance (so balances
 * never change backwards), and the per-request limit is a creation rule.
 * A deactivated type is no longer offered; its existing requests can still
 * be approved, rejected or cancelled.
 */
export async function updateLeaveType(actorId: string, id: string, input: UpdateLeaveTypeInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockLeaveType(tx, id);
      const current = await tx.leaveType.findUnique({ where: { id }, select: leaveTypeSelect });
      if (!current) {
        throw new NotFoundError(NOT_FOUND);
      }

      // Optimistic concurrency: the client edited what it loaded; if someone
      // saved since, overwriting their change silently would lose it.
      if (input.expectedUpdatedAt !== undefined && new Date(input.expectedUpdatedAt).getTime() !== current.updatedAt.getTime()) {
        throw withCode(
          new ConflictError("Alguien más cambió este tipo de permiso mientras lo editabas; vuelve a abrirlo para ver lo actual"),
          "STALE_DATA",
        );
      }

      const changed = EDITABLE_FIELDS.filter((field) => input[field] !== undefined && input[field] !== current[field]);
      // Nothing actually changes: nothing is written or logged.
      if (changed.length === 0) {
        return serialize(current);
      }
      if (input.name !== undefined && changed.includes("name") && (await nameTaken(tx, input.name, id))) {
        throw duplicateName();
      }

      // The type as it would end up: the LFT rule looks at both fields together,
      // but only when one of them changes. A legacy row that breaks the rule
      // (no CHECK in the database) can still be renamed or deactivated; only
      // touching its limit or "descuenta" requires fixing it.
      const next = {
        name: input.name ?? current.name,
        countsAgainstVacationBalance: input.countsAgainstVacationBalance ?? current.countsAgainstVacationBalance,
        maxBusinessDaysPerRequest:
          input.maxBusinessDaysPerRequest === undefined ? current.maxBusinessDaysPerRequest : input.maxBusinessDaysPerRequest,
        isActive: input.isActive ?? current.isActive,
      };
      if (changed.includes("countsAgainstVacationBalance") || changed.includes("maxBusinessDaysPerRequest")) {
        assertLftMinimum(next);
      }

      // Only the changed fields, each with its own type (no untyped assign).
      const data: Prisma.LeaveTypeUpdateInput = {
        ...(changed.includes("name") ? { name: next.name } : {}),
        ...(changed.includes("countsAgainstVacationBalance")
          ? { countsAgainstVacationBalance: next.countsAgainstVacationBalance }
          : {}),
        ...(changed.includes("maxBusinessDaysPerRequest")
          ? { maxBusinessDaysPerRequest: next.maxBusinessDaysPerRequest }
          : {}),
        ...(changed.includes("isActive") ? { isActive: next.isActive } : {}),
      };
      const updated = await tx.leaveType.update({ where: { id }, data, select: leaveTypeSelect });
      await recordHrAudit(tx, {
        actorId,
        entityType: "LEAVE_TYPE",
        entityId: id,
        action: auditAction(changed, updated.isActive),
        before: snapshot(current),
        after: snapshot(updated),
      });
      return serialize(updated);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateName();
    throw err;
  }
}
