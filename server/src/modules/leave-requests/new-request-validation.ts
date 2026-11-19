/**
 * Validation of a NEW leave request, shared by `POST /api/leave-requests`
 * (which throws the first problem) and `GET /api/leave-requests/preview`
 * (which reports every problem). Both call exactly these functions, so the
 * preview can never promise something the POST would reject, or vice versa.
 *
 * Split in two phases on purpose:
 * 1. `evaluateRequestInput` depends only on the input, the calendar and the
 *    leave type: the POST runs it before opening the transaction.
 * 2. `evaluateAgainstUserState` reads the user's other requests and balance:
 *    the POST runs it inside the transaction, after `lockUser`, so no
 *    concurrent request can slip in between the check and the insert.
 */
import { countBusinessDays, getLatestRequestableStartDate } from "../../domain/vacation.js";
import { toISODate } from "../../domain/dates.js";
import {
  BadRequestError,
  ConflictError,
  UnprocessableEntityError,
  type AppError,
} from "../../errors/AppError.js";
import { getVacationBalance, type DbClient } from "../balance/balance.service.js";

export type ProblemCode =
  | "START_IN_PAST"
  | "START_TOO_FAR"
  | "INVALID_LEAVE_TYPE"
  | "NO_BUSINESS_DAYS"
  | "EXCEEDS_TYPE_LIMIT"
  | "OVERLAP"
  | "INSUFFICIENT_BALANCE";

export interface LeaveRequestProblem {
  code: ProblemCode;
  message: string;
}

/** HTTP status the POST answers with for each problem. */
const PROBLEM_ERROR: Record<ProblemCode, (message: string) => AppError> = {
  START_IN_PAST: (message) => new BadRequestError(message),
  START_TOO_FAR: (message) => new BadRequestError(message),
  INVALID_LEAVE_TYPE: (message) => new BadRequestError(message),
  NO_BUSINESS_DAYS: (message) => new BadRequestError(message),
  EXCEEDS_TYPE_LIMIT: (message) => new BadRequestError(message),
  OVERLAP: (message) => new ConflictError(message),
  INSUFFICIENT_BALANCE: (message) => new UnprocessableEntityError(message),
};

/** The POST's error for a problem: same message as the preview, and the same `code`. */
export function problemToError(problem: LeaveRequestProblem): AppError {
  const error = PROBLEM_ERROR[problem.code](problem.message);
  error.code = problem.code;
  return error;
}

/** At least one problem: lets "throw the first one" type-check without a guard. */
export type Problems = [LeaveRequestProblem, ...LeaveRequestProblem[]];

function hasProblems(problems: LeaveRequestProblem[]): problems is Problems {
  return problems.length > 0;
}

/** Problems about the start date itself: with them, a balance would be for the wrong period. */
const DATE_PROBLEMS: ReadonlySet<ProblemCode> = new Set(["START_IN_PAST", "START_TOO_FAR"]);

export function hasDateProblem(problems: readonly LeaveRequestProblem[]): boolean {
  return problems.some((problem) => DATE_PROBLEMS.has(problem.code));
}

export const OVERLAP_MESSAGE =
  "Ya tienes una solicitud pendiente o aprobada que se encima con esas fechas";

const leaveTypeSelect = {
  id: true,
  code: true,
  name: true,
  countsAgainstVacationBalance: true,
  maxBusinessDaysPerRequest: true,
  isActive: true,
} as const;

export interface EvaluatedLeaveType {
  id: string;
  code: string;
  name: string;
  countsAgainstVacationBalance: boolean;
  /** Most business days one request may cover; null = no limit. */
  maxBusinessDaysPerRequest: number | null;
}

interface RequestDates {
  startDate: Date;
  endDate: Date;
}

/**
 * `ok: true` guarantees a valid leave type and no problems, so the POST can
 * go on without re-checking; `ok: false` still carries what could be computed,
 * for the preview.
 */
export type InputEvaluation =
  | { ok: true; leaveType: EvaluatedLeaveType; businessDays: number; problems: [] }
  | {
      ok: false;
      /** null when the leave type does not exist or is inactive. */
      leaveType: EvaluatedLeaveType | null;
      businessDays: number;
      problems: Problems;
    };

/**
 * Phase 1: date limits, leave type and business days. `today` is the
 * calendar date in APP_TIMEZONE (UTC midnight).
 */
export async function evaluateRequestInput(
  db: DbClient,
  user: { hireDate: Date },
  input: RequestDates & { leaveTypeId: string },
  today: Date,
): Promise<InputEvaluation> {
  const { startDate, endDate, leaveTypeId } = input;
  const problems: LeaveRequestProblem[] = [];

  if (startDate.getTime() < today.getTime()) {
    problems.push({
      code: "START_IN_PAST",
      message: "La fecha de inicio no puede ser anterior a hoy",
    });
  }

  const latestStart = getLatestRequestableStartDate(user.hireDate, today);
  if (startDate.getTime() > latestStart.getTime()) {
    problems.push({
      code: "START_TOO_FAR",
      message:
        "La fecha de inicio debe caer en tu periodo actual o en el siguiente " +
        `(a más tardar ${toISODate(latestStart)})`,
    });
  }

  const found = await db.leaveType.findUnique({ where: { id: leaveTypeId }, select: leaveTypeSelect });
  let leaveType: EvaluatedLeaveType | null = null;
  if (!found || !found.isActive) {
    problems.push({ code: "INVALID_LEAVE_TYPE", message: "Tipo de permiso no válido o inactivo" });
  } else {
    const { isActive: _isActive, ...rest } = found;
    leaveType = rest;
  }

  const holidays = await db.holiday.findMany({
    where: { date: { gte: startDate, lte: endDate } },
    select: { date: true },
  });
  const businessDays = countBusinessDays(
    startDate,
    endDate,
    holidays.map((h) => h.date),
  );
  if (businessDays === 0) {
    problems.push({
      code: "NO_BUSINESS_DAYS",
      message: "El rango no incluye días hábiles (solo fines de semana o festivos)",
    });
  }

  // Phase 1: it depends only on the input and the leave type. The limit is a
  // rule for creating requests; lowering it never touches existing ones.
  const limit = leaveType?.maxBusinessDaysPerRequest ?? null;
  if (leaveType && limit !== null && businessDays > limit) {
    problems.push({
      code: "EXCEEDS_TYPE_LIMIT",
      message:
        `${leaveType.name} permite máximo ${limit} ${limit === 1 ? "día hábil" : "días hábiles"} ` +
        `por solicitud; esta tiene ${businessDays}`,
    });
  }

  if (hasProblems(problems)) {
    return { ok: false, leaveType, businessDays, problems };
  }
  if (!leaveType) {
    // Unreachable: a missing leave type is always pushed as a problem above.
    throw new Error("Leave type missing without a reported problem");
  }
  return { ok: true, leaveType, businessDays, problems: [] };
}

export interface BalanceImpact {
  period: { start: Date; end: Date };
  available: number;
  availableAfter: number;
}

export interface UserStateEvaluation {
  /**
   * null when the leave type does not count against the vacation balance, or
   * when the balance was not checked (`checkBalance: false`).
   */
  balance: BalanceImpact | null;
  problems: LeaveRequestProblem[];
}

/**
 * Phase 2: overlapping requests and the balance of the anniversary period
 * where `startDate` falls. The POST calls it with the transaction client,
 * after `lockUser`.
 */
export async function evaluateAgainstUserState(
  db: DbClient,
  user: { id: string; hireDate: Date },
  request: RequestDates & { leaveType: EvaluatedLeaveType; businessDays: number },
  /**
   * false when the start date itself is invalid (only the preview gets this
   * far with one): the balance of 2099's period, say, would only confuse.
   */
  options: { checkBalance: boolean } = { checkBalance: true },
): Promise<UserStateEvaluation> {
  const { startDate, endDate, leaveType, businessDays } = request;
  const problems: LeaveRequestProblem[] = [];

  const overlapping = await db.leaveRequest.findFirst({
    where: {
      requesterId: user.id,
      status: { in: ["PENDING", "APPROVED"] },
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
    select: { startDate: true, endDate: true },
  });
  if (overlapping) {
    problems.push({
      code: "OVERLAP",
      message: `${OVERLAP_MESSAGE} (${toISODate(overlapping.startDate)} a ${toISODate(overlapping.endDate)})`,
    });
  }

  if (!options.checkBalance || !leaveType.countsAgainstVacationBalance) {
    return { balance: null, problems };
  }

  // The request counts in the anniversary period where startDate falls,
  // so that is the period whose balance must cover it.
  const balance = await getVacationBalance(db, user, startDate);
  const availableAfter = balance.available - businessDays;
  // With 0 business days phase 1 already reported NO_BUSINESS_DAYS; a period
  // made negative by an HR adjustment must not add "you request 0 days".
  if (businessDays > 0 && availableAfter < 0) {
    problems.push({
      code: "INSUFFICIENT_BALANCE",
      message:
        `Saldo insuficiente: solicitas ${businessDays} días hábiles y tienes ` +
        `${Math.max(balance.available, 0)} disponibles en el periodo ` +
        `${toISODate(balance.period.start)} a ${toISODate(balance.period.end)}`,
    });
  }

  return {
    balance: { period: balance.period, available: balance.available, availableAfter },
    problems,
  };
}
