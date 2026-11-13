/**
 * Pure state machine for leave requests. No Prisma, no Express: the caller
 * passes the current status, the action and the dates (UTC-midnight values,
 * with `today` already computed in the company timezone).
 *
 *   PENDING  -> APPROVED | REJECTED | CANCELLED
 *   APPROVED -> CANCELLED   (only while the leave has not started yet)
 *   REJECTED, CANCELLED     final states
 */

import type { LeaveRequestStatus } from "./vacation.js";

export type LeaveRequestAction = "APPROVE" | "REJECT" | "CANCEL";

export type TransitionResult =
  | { ok: true; next: LeaveRequestStatus }
  | { ok: false; reason: string };

/** A request has started once its startDate is today or earlier. */
export function hasStarted(startDate: Date, today: Date): boolean {
  return startDate.getTime() <= today.getTime();
}

export function transition(
  current: LeaveRequestStatus,
  action: LeaveRequestAction,
  dates: { startDate: Date; today: Date },
): TransitionResult {
  switch (current) {
    case "PENDING":
      if (action === "APPROVE") return { ok: true, next: "APPROVED" };
      if (action === "REJECT") return { ok: true, next: "REJECTED" };
      return { ok: true, next: "CANCELLED" };

    case "APPROVED":
      if (action !== "CANCEL") {
        return { ok: false, reason: "La solicitud ya fue aprobada" };
      }
      if (hasStarted(dates.startDate, dates.today)) {
        return {
          ok: false,
          reason: "No se puede cancelar una solicitud aprobada que ya inició",
        };
      }
      return { ok: true, next: "CANCELLED" };

    case "REJECTED":
      return { ok: false, reason: "La solicitud ya fue rechazada" };

    case "CANCELLED":
      return { ok: false, reason: "La solicitud ya fue cancelada" };
  }
}
