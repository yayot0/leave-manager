import { z } from "zod";
import { diffInDays, parseISODate } from "../../domain/dates.js";

/** Longest range accepted in a single request (also bounds countBusinessDays). */
export const MAX_REQUEST_RANGE_DAYS = 366;

const isoDate = z
  .string()
  .transform((value, ctx) => {
    const date = parseISODate(value);
    if (!date) {
      ctx.addIssue({ code: "custom", message: "La fecha debe tener formato YYYY-MM-DD y ser válida" });
      return z.NEVER;
    }
    return date;
  });

export const createLeaveRequestSchema = z
  .object({
    leaveTypeId: z
      .string()
      .trim()
      .min(1, "leaveTypeId es obligatorio")
      .max(64, "leaveTypeId no es válido"),
    startDate: isoDate,
    endDate: isoDate,
    reason: z
      .string()
      .trim()
      .max(500, "El motivo no puede exceder 500 caracteres")
      .optional()
      .transform((value) => (value ? value : undefined)),
  })
  .strict()
  .refine((data) => data.endDate.getTime() >= data.startDate.getTime(), {
    message: "La fecha de fin no puede ser anterior a la fecha de inicio",
    path: ["endDate"],
  })
  .refine((data) => diffInDays(data.startDate, data.endDate) < MAX_REQUEST_RANGE_DAYS, {
    message: `El rango no puede exceder ${MAX_REQUEST_RANGE_DAYS} días`,
    path: ["endDate"],
  });

export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
