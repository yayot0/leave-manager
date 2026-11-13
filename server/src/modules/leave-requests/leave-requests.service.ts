import { prisma } from "../../db/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { isOverlapConstraintViolation } from "../../db/pg-errors.js";
import { lockUser } from "../../db/locks.js";
import { env } from "../../config/env.js";
import { countBusinessDays, getLatestRequestableStartDate } from "../../domain/vacation.js";
import { todayInTimeZone, toISODate } from "../../domain/dates.js";
import {
  BadRequestError,
  ConflictError,
  UnprocessableEntityError,
} from "../../errors/AppError.js";
import { getVacationBalance } from "../balance/balance.service.js";
import type { CreateLeaveRequestInput } from "./leave-requests.schemas.js";

const OVERLAP_MESSAGE = "Ya tienes una solicitud pendiente o aprobada que se encima con esas fechas";

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
  leaveType: {
    select: { id: true, code: true, name: true, countsAgainstVacationBalance: true },
  },
} satisfies Prisma.LeaveRequestSelect;

// Derived from the select itself, so it can never drift from what we query.
type LeaveRequestRow = Prisma.LeaveRequestGetPayload<{ select: typeof leaveRequestSelect }>;

export function serializeLeaveRequest(row: LeaveRequestRow) {
  return {
    ...row,
    startDate: toISODate(row.startDate),
    endDate: toISODate(row.endDate),
  };
}

export async function createLeaveRequest(
  user: { id: string; hireDate: Date },
  input: CreateLeaveRequestInput,
) {
  const { startDate, endDate, leaveTypeId, reason } = input;

  const today = todayInTimeZone(env.APP_TIMEZONE);
  if (startDate.getTime() < today.getTime()) {
    throw new BadRequestError("La fecha de inicio no puede ser anterior a hoy");
  }

  const latestStart = getLatestRequestableStartDate(user.hireDate, today);
  if (startDate.getTime() > latestStart.getTime()) {
    throw new BadRequestError(
      "La fecha de inicio debe caer en tu periodo actual o en el siguiente " +
        `(a más tardar ${toISODate(latestStart)})`,
    );
  }

  const leaveType = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } });
  if (!leaveType || !leaveType.isActive) {
    throw new BadRequestError("Tipo de permiso no válido o inactivo");
  }

  const holidays = await prisma.holiday.findMany({
    where: { date: { gte: startDate, lte: endDate } },
    select: { date: true },
  });
  const businessDays = countBusinessDays(
    startDate,
    endDate,
    holidays.map((h) => h.date),
  );
  if (businessDays === 0) {
    throw new BadRequestError(
      "El rango no incluye días hábiles (solo fines de semana o festivos)",
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Serializes "read balance + insert" per user: a concurrent request from
      // the same user waits here until this transaction commits, and then
      // sees the request created by it when computing its own balance.
      await lockUser(tx, user.id);

      const overlapping = await tx.leaveRequest.findFirst({
        where: {
          requesterId: user.id,
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: endDate },
          endDate: { gte: startDate },
        },
        select: { startDate: true, endDate: true, status: true },
      });
      if (overlapping) {
        throw new ConflictError(
          `${OVERLAP_MESSAGE} (${toISODate(overlapping.startDate)} a ${toISODate(overlapping.endDate)})`,
        );
      }

      if (leaveType.countsAgainstVacationBalance) {
        // The request counts in the anniversary period where startDate falls,
        // so that is the period whose balance must cover it.
        const balance = await getVacationBalance(tx, user, startDate);
        if (businessDays > balance.available) {
          throw new UnprocessableEntityError(
            `Saldo insuficiente: solicitas ${businessDays} días hábiles y tienes ` +
              `${Math.max(balance.available, 0)} disponibles en el periodo ` +
              `${toISODate(balance.period.start)} a ${toISODate(balance.period.end)}`,
          );
        }
      }

      const created = await tx.leaveRequest.create({
        data: {
          requesterId: user.id,
          leaveTypeId: leaveType.id,
          startDate,
          endDate,
          businessDays,
          reason,
          status: "PENDING",
          events: { create: { action: "CREATED", actorId: user.id } },
        },
        select: leaveRequestSelect,
      });
      return serializeLeaveRequest(created);
    });
  } catch (err) {
    // Safety net: if a concurrent insert slipped past the app-level check,
    // the EXCLUDE constraint rejects it; report it as the same 409.
    if (isOverlapConstraintViolation(err)) {
      throw new ConflictError(OVERLAP_MESSAGE);
    }
    throw err;
  }
}

export async function listMyLeaveRequests(userId: string) {
  const rows = await prisma.leaveRequest.findMany({
    where: { requesterId: userId },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select: leaveRequestSelect,
  });
  return rows.map(serializeLeaveRequest);
}
