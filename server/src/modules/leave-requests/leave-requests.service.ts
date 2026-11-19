import { prisma } from "../../db/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { isOverlapConstraintViolation } from "../../db/pg-errors.js";
import { lockUser } from "../../db/locks.js";
import { env } from "../../config/env.js";
import { todayInTimeZone, toISODate } from "../../domain/dates.js";
import { transition } from "../../domain/leave-request-state.js";
import type { CreateLeaveRequestInput, PreviewLeaveRequestInput } from "./leave-requests.schemas.js";
import {
  evaluateAgainstUserState,
  evaluateRequestInput,
  hasDateProblem,
  OVERLAP_MESSAGE,
  problemToError,
  type EvaluatedLeaveType,
  type LeaveRequestProblem,
} from "./new-request-validation.js";

const leaveRequestSelect = {
  id: true,
  startDate: true,
  endDate: true,
  businessDays: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  // The request's own copy (what its balance uses), which may differ from
  // leaveType.countsAgainstVacationBalance if HR edited the type later.
  countsAgainstVacationBalance: true,
  leaveType: {
    select: { id: true, code: true, name: true, countsAgainstVacationBalance: true },
  },
} satisfies Prisma.LeaveRequestSelect;

// Derived from the select itself, so it can never drift from what we query.
type LeaveRequestRow = Prisma.LeaveRequestGetPayload<{ select: typeof leaveRequestSelect }>;

/**
 * `permissions.canCancel` comes from the same state machine the cancel
 * endpoint uses, so the client never re-implements it. `today` is the
 * calendar date in APP_TIMEZONE.
 */
export function serializeLeaveRequest(row: LeaveRequestRow, today: Date) {
  return {
    ...row,
    startDate: toISODate(row.startDate),
    endDate: toISODate(row.endDate),
    permissions: {
      canCancel: transition(row.status, "CANCEL", { startDate: row.startDate, today }).ok,
    },
  };
}

export async function createLeaveRequest(
  user: { id: string; hireDate: Date },
  input: CreateLeaveRequestInput,
) {
  const { startDate, endDate, reason } = input;

  // Phase 1 (input, calendar, leave type) needs no lock.
  const today = todayInTimeZone(env.APP_TIMEZONE);
  const evaluated = await evaluateRequestInput(prisma, user, input, today);
  if (!evaluated.ok) {
    throw problemToError(evaluated.problems[0]);
  }
  const { leaveType, businessDays } = evaluated;

  try {
    return await prisma.$transaction(async (tx) => {
      // Serializes "read balance + insert" per user: a concurrent request from
      // the same user waits here until this transaction commits, and then
      // sees the request created by it when computing its own balance.
      await lockUser(tx, user.id);

      // Phase 2 (overlaps, balance) runs under the lock.
      const state = await evaluateAgainstUserState(tx, user, {
        startDate,
        endDate,
        leaveType,
        businessDays,
      });
      const [firstProblem] = state.problems;
      if (firstProblem) {
        throw problemToError(firstProblem);
      }

      const created = await tx.leaveRequest.create({
        data: {
          requesterId: user.id,
          leaveTypeId: leaveType.id,
          // Copy taken from the same leave type phase 1 validated, so the
          // balance check above and the stored copy always agree.
          countsAgainstVacationBalance: leaveType.countsAgainstVacationBalance,
          startDate,
          endDate,
          businessDays,
          reason,
          status: "PENDING",
          events: { create: { action: "CREATED", actorId: user.id } },
        },
        select: leaveRequestSelect,
      });
      return serializeLeaveRequest(created, today);
    });
  } catch (err) {
    // Safety net: if a concurrent insert slipped past the app-level check,
    // the EXCLUDE constraint rejects it; report it as the same 409.
    if (isOverlapConstraintViolation(err)) {
      throw problemToError({ code: "OVERLAP", message: OVERLAP_MESSAGE });
    }
    throw err;
  }
}

export interface LeaveRequestPreview {
  businessDays: number;
  leaveType: EvaluatedLeaveType | null;
  /** Dates as "YYYY-MM-DD". null if the type does not count, or the start date is invalid. */
  balance: { period: { start: string; end: string }; available: number; availableAfter: number } | null;
  problems: LeaveRequestProblem[];
  canSubmit: boolean;
}

/**
 * GET /api/leave-requests/preview — what POST would do with the same input,
 * without writing anything or taking locks. Runs the same two validation
 * phases as createLeaveRequest, but collects problems instead of throwing
 * the first one. Phase 2 is skipped when the leave type is invalid (there is
 * no type to check against), and the balance when the start date is invalid
 * (it would be another period's). The POST would have stopped at phase 1 in
 * both cases, so `canSubmit` still matches it exactly. Being lock-free, it is
 * a snapshot: the POST re-checks everything under the lock.
 */
export async function previewLeaveRequest(
  user: { id: string; hireDate: Date },
  input: PreviewLeaveRequestInput,
): Promise<LeaveRequestPreview> {
  const today = todayInTimeZone(env.APP_TIMEZONE);
  const evaluated = await evaluateRequestInput(prisma, user, input, today);
  const problems: LeaveRequestProblem[] = [...evaluated.problems];

  let balance: LeaveRequestPreview["balance"] = null;
  if (evaluated.leaveType) {
    const state = await evaluateAgainstUserState(
      prisma,
      user,
      {
        startDate: input.startDate,
        endDate: input.endDate,
        leaveType: evaluated.leaveType,
        businessDays: evaluated.businessDays,
      },
      { checkBalance: !hasDateProblem(evaluated.problems) },
    );
    problems.push(...state.problems);
    if (state.balance) {
      balance = {
        ...state.balance,
        period: {
          start: toISODate(state.balance.period.start),
          end: toISODate(state.balance.period.end),
        },
      };
    }
  }

  return {
    businessDays: evaluated.businessDays,
    leaveType: evaluated.leaveType,
    balance,
    problems,
    canSubmit: problems.length === 0,
  };
}

export async function listMyLeaveRequests(userId: string) {
  const rows = await prisma.leaveRequest.findMany({
    where: { requesterId: userId },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select: leaveRequestSelect,
  });
  const today = todayInTimeZone(env.APP_TIMEZONE);
  return rows.map((row) => serializeLeaveRequest(row, today));
}
