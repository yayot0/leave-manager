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

// Only length is checked (not the cuid format) on purpose: a malformed id must
// get the same 404 as a nonexistent one, so ids cannot be probed by format.
export const leaveRequestIdSchema = z
  .string()
  .trim()
  .min(1, "Id inválido")
  .max(64, "Id inválido");

const optionalNote = z
  .string()
  .trim()
  .max(500, "La nota no puede exceder 500 caracteres")
  .optional()
  .transform((value) => (value ? value : undefined));

/** approve and cancel: note is optional. */
export const optionalNoteSchema = z.object({ note: optionalNote }).strict();

/** reject: the employee deserves to know why, so the note is required. */
export const requiredNoteSchema = z
  .object({
    note: z
      .string({ error: "La nota es obligatoria al rechazar" })
      .trim()
      .min(1, "La nota es obligatoria al rechazar")
      .max(500, "La nota no puede exceder 500 caracteres"),
  })
  .strict();
