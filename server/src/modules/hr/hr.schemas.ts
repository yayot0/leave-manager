import { z } from "zod";
import { isoDate } from "../leave-requests/leave-requests.schemas.js";

/**
 * Input of the HR catalog endpoints. Every object is `.strict()`: an unknown
 * field (e.g. `code` when editing a leave type) is a 400, never ignored.
 * Limits stay inside the database CHECKs (names 1–100 chars, codes 30), so
 * anything Zod accepts the database accepts too: no 500s from bad input.
 */

/** Only length, like leaveRequestIdSchema: a malformed id gets the same 404. */
export const catalogIdSchema = z.string().trim().min(1, "Id inválido").max(64, "Id inválido");

// .trim() also removes tabs, newlines and non-breaking spaces at the ends,
// which btrim in the database CHECK would not: Zod is the stricter of the
// two. The regex rejects control characters anywhere (a \u0000 would even
// make Postgres fail with 22021, a 500).
const name = (label: string) =>
  z
    .string({ error: `${label} es obligatorio` })
    .trim()
    .min(2, `${label} debe tener al menos 2 caracteres`)
    .max(60, `${label} no puede exceder 60 caracteres`)
    .regex(/^[^\p{Cc}]+$/u, `${label} no puede tener saltos de línea ni caracteres de control`);

// ---------- Departments ----------

export const departmentInputSchema = z.object({ name: name("El nombre") }).strict();

// ---------- Leave types ----------

const maxBusinessDaysPerRequest = z
  .number({ error: "El máximo debe ser un número entero o null" })
  .int("El máximo debe ser un número entero")
  .min(1, "El máximo debe ser al menos 1 día hábil")
  .max(365, "El máximo no puede exceder 365 días hábiles")
  .nullable();

export const createLeaveTypeSchema = z
  .object({
    code: z
      .string({ error: "El código es obligatorio" })
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,19}$/, "El código debe tener de 2 a 20 caracteres: mayúsculas, números o _, empezando con letra"),
    name: name("El nombre"),
    countsAgainstVacationBalance: z.boolean({ error: "Indica si descuenta de vacaciones" }),
    maxBusinessDaysPerRequest: maxBusinessDaysPerRequest.optional().transform((value) => value ?? null),
  })
  .strict();

/**
 * `code` is not editable on purpose (stable identifier for the seed,
 * integrations and the audit log): `.strict()` turns it into a 400.
 */
export const updateLeaveTypeSchema = z
  .object({
    name: name("El nombre").optional(),
    countsAgainstVacationBalance: z.boolean().optional(),
    maxBusinessDaysPerRequest: maxBusinessDaysPerRequest.optional(),
    isActive: z.boolean().optional(),
    /**
     * Optimistic concurrency: the `updatedAt` the client loaded. If someone
     * saved the type since, the PATCH is a 409 STALE_DATA instead of silently
     * overwriting their change. Optional for other API clients.
     */
    expectedUpdatedAt: z.iso.datetime({ error: "expectedUpdatedAt debe ser una fecha ISO" }).optional(),
  })
  .strict()
  .refine(
    ({ expectedUpdatedAt: _expected, ...fields }) => Object.values(fields).some((value) => value !== undefined),
    { message: "Indica al menos un campo a cambiar" },
  );

export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;

// ---------- Holidays ----------

export const holidaysQuerySchema = z
  .object({
    year: z.coerce
      .number({ error: "El año es obligatorio" })
      .int("El año debe ser un número entero")
      .min(2000, "El año debe estar entre 2000 y 2100")
      .max(2100, "El año debe estar entre 2000 y 2100"), // = HOLIDAY_YEAR_MIN/MAX
  })
  .strict();

export const holidayImpactQuerySchema = z.object({ date: isoDate }).strict();

/** Same range as the yearly list: a holiday the list could never show is a typo. */
export const HOLIDAY_YEAR_MIN = 2000;
export const HOLIDAY_YEAR_MAX = 2100;

export const createHolidaySchema = z
  .object({
    date: isoDate.refine(
      (date) => date.getUTCFullYear() >= HOLIDAY_YEAR_MIN && date.getUTCFullYear() <= HOLIDAY_YEAR_MAX,
      `La fecha debe estar entre ${HOLIDAY_YEAR_MIN} y ${HOLIDAY_YEAR_MAX}`,
    ),
    name: name("El nombre"),
  })
  .strict();

export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
