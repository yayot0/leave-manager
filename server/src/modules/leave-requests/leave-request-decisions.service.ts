import { prisma } from "../../db/prisma.js";
import { lockLeaveRequest, lockUser } from "../../db/locks.js";
import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { todayInTimeZone, toISODate } from "../../domain/dates.js";
import { canDecide, canView, type Actor } from "../../domain/leave-request-policy.js";
import {
  hasStarted,
  transition,
  type LeaveRequestAction,
} from "../../domain/leave-request-state.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../errors/AppError.js";
import { getVacationBalance, type DbClient } from "../balance/balance.service.js";

const NOT_FOUND_MESSAGE = "Solicitud no encontrada";

const personSelect = { id: true, firstName: true, lastName: true } as const;

const requesterSelect = {
  ...personSelect,
  hireDate: true,
  managerId: true,
  manager: { select: { isActive: true } },
} satisfies Prisma.UserSelect;

const detailSelect = {
  id: true,
  startDate: true,
  endDate: true,
  businessDays: true,
  reason: true,
  status: true,
  deciderId: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  updatedAt: true,
  leaveType: {
    select: { id: true, code: true, name: true, countsAgainstVacationBalance: true },
  },
  requester: { select: requesterSelect },
  decider: { select: personSelect },
  events: {
    // id breaks ties between events created in the same millisecond.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      action: true,
      note: true,
      createdAt: true,
      actor: { select: personSelect },
    },
  },
} satisfies Prisma.LeaveRequestSelect;

type DetailRow = Prisma.LeaveRequestGetPayload<{ select: typeof detailSelect }>;

/** What approve/reject/cancel need to read under the locks. */
const decisionSelect = {
  status: true,
  startDate: true,
  deciderId: true,
  requester: { select: requesterSelect },
  leaveType: { select: { countsAgainstVacationBalance: true } },
} satisfies Prisma.LeaveRequestSelect;

function serializeDetail(row: DetailRow, actor: Actor, today: Date) {
  const { requester, deciderId: _deciderId, ...rest } = row;
  const isRequester = actor.id === requester.id;
  const decidable = row.status === "PENDING" && canDecide(actor, requester);
  return {
    ...rest,
    startDate: toISODate(row.startDate),
    endDate: toISODate(row.endDate),
    // Only expose who asked, never their manager/hire data.
    requester: { id: requester.id, firstName: requester.firstName, lastName: requester.lastName },
    isOverdue: row.status === "PENDING" && hasStarted(row.startDate, today),
    permissions: {
      canApprove: decidable,
      canReject: decidable,
      canCancel:
        isRequester && transition(row.status, "CANCEL", { startDate: row.startDate, today }).ok,
    },
  };
}

async function findDetail(db: DbClient, id: string): Promise<DetailRow | null> {
  return db.leaveRequest.findUnique({ where: { id }, select: detailSelect });
}

/** GET /api/leave-requests/:id — 404 (not 403) for anyone who may not see it. */
export async function getLeaveRequestDetail(actor: Actor, id: string) {
  const row = await findDetail(prisma, id);
  if (!row || !canView(actor, { requester: row.requester, deciderId: row.deciderId })) {
    throw new NotFoundError(NOT_FOUND_MESSAGE);
  }
  return serializeDetail(row, actor, todayInTimeZone(env.APP_TIMEZONE));
}

/**
 * GET /api/leave-requests/pending-approvals — PENDING requests the actor can
 * decide, oldest start first (so overdue ones come first).
 */
export async function listPendingApprovals(actor: Actor) {
  // Mirrors canDecide(): direct active manager, or HR when the requester has
  // no active manager. Never the actor's own requests.
  const decidableBy: Prisma.LeaveRequestWhereInput[] = [
    { requester: { managerId: actor.id, manager: { isActive: true } } },
  ];
  if (actor.role === "HR") {
    decidableBy.push({
      requester: { OR: [{ managerId: null }, { manager: { isActive: false } }] },
    });
  }

  const rows = await prisma.leaveRequest.findMany({
    where: { status: "PENDING", requesterId: { not: actor.id }, OR: decidableBy },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      startDate: true,
      endDate: true,
      businessDays: true,
      reason: true,
      createdAt: true,
      leaveType: { select: { id: true, code: true, name: true, countsAgainstVacationBalance: true } },
      requester: { select: personSelect },
    },
  });

  const today = todayInTimeZone(env.APP_TIMEZONE);
  return rows.map((row) => ({
    ...row,
    startDate: toISODate(row.startDate),
    endDate: toISODate(row.endDate),
    isOverdue: hasStarted(row.startDate, today),
  }));
}

const EVENT_FOR_ACTION = {
  APPROVE: "APPROVED",
  REJECT: "REJECTED",
  CANCEL: "CANCELLED",
} as const;

/**
 * Approve, reject or cancel a request. Race-free because, inside one
 * transaction, it:
 * 1. locks the requester's user row (same lock as request creation), then
 *    the request row — always in that order, so no deadlocks;
 * 2. re-reads the request AFTER acquiring the locks, so a concurrent
 *    operation that won the race is visible and this one gets a 409;
 * 3. updates with `WHERE status = <status it read>` as a second safety net:
 *    if the status somehow changed anyway, 0 rows are updated -> 409.
 */
export async function applyLeaveRequestAction(
  actor: Actor,
  id: string,
  action: LeaveRequestAction,
  note: string | undefined,
) {
  // Visibility is checked BEFORE opening the transaction, so a hidden id and a
  // nonexistent id cost the same single query (no timing difference) and
  // nobody can lock rows of requests they are not allowed to see.
  // requesterId never changes, so it is safe to read it before locking.
  const visible = await prisma.leaveRequest.findUnique({
    where: { id },
    select: { requesterId: true, deciderId: true, requester: { select: requesterSelect } },
  });
  if (!visible || !canView(actor, { requester: visible.requester, deciderId: visible.deciderId })) {
    throw new NotFoundError(NOT_FOUND_MESSAGE);
  }

  await prisma.$transaction(async (tx) => {
    await lockUser(tx, visible.requesterId);
    await lockLeaveRequest(tx, id);

    // Computed after waiting for the locks, so a wait across midnight in
    // APP_TIMEZONE still uses the right "today".
    const today = todayInTimeZone(env.APP_TIMEZONE);

    // Re-read and re-check under the locks: the manager or their isActive
    // flag may have changed since the visibility check above.
    // Only what the decision needs; the full detail (events, people) is
    // loaded after commit, outside the transaction.
    const request = await tx.leaveRequest.findUnique({ where: { id }, select: decisionSelect });
    if (!request || !canView(actor, { requester: request.requester, deciderId: request.deciderId })) {
      throw new NotFoundError(NOT_FOUND_MESSAGE);
    }

    if (action === "CANCEL") {
      if (actor.id !== request.requester.id) {
        throw new ForbiddenError("Solo quien hizo la solicitud puede cancelarla");
      }
    } else if (actor.id === request.requester.id) {
      throw new ForbiddenError("No puedes aprobar ni rechazar tus propias solicitudes");
    } else if (!canDecide(actor, request.requester)) {
      throw new ForbiddenError("No te corresponde decidir esta solicitud");
    }

    const result = transition(request.status, action, { startDate: request.startDate, today });
    if (!result.ok) {
      throw new ConflictError(result.reason);
    }

    if (action === "APPROVE" && request.leaveType.countsAgainstVacationBalance) {
      // PENDING -> APPROVED does not change the total already reserved, so
      // the period stays valid as long as available >= 0. It can be negative
      // if HR applied a negative adjustment after the request was created.
      const balance = await getVacationBalance(tx, request.requester, request.startDate);
      if (balance.available < 0) {
        throw new UnprocessableEntityError(
          `Saldo insuficiente para aprobar: el periodo ${toISODate(balance.period.start)} a ` +
            `${toISODate(balance.period.end)} quedaría con ${balance.available} días`,
        );
      }
    }

    const data: Prisma.LeaveRequestUncheckedUpdateManyInput =
      action === "CANCEL"
        ? // The employee cancelling never touches decider_id/decided_at.
          { status: result.next }
        : {
            status: result.next,
            deciderId: actor.id,
            decidedAt: new Date(),
            decisionNote: note ?? null,
          };

    const updated = await tx.leaveRequest.updateMany({
      where: { id, status: request.status },
      data,
    });
    if (updated.count !== 1) {
      throw new ConflictError("La solicitud cambió de estado; vuelve a cargarla");
    }

    await tx.requestEvent.create({
      data: { leaveRequestId: id, actorId: actor.id, action: EVENT_FOR_ACTION[action], note },
    });
  });

  // After commit: the response reflects the committed state (including the
  // new event). Using the pool instead of the transaction connection also
  // keeps Prisma's parallel relation loads off a single pg client.
  return getLeaveRequestDetail(actor, id);
}
