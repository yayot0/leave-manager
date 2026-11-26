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

// ---------- Employees ----------

const ROLES = ["EMPLOYEE", "MANAGER", "HR"] as const;

/** Stored normalized (trimmed, lowercase), as login reads it; CHECK chk_users_email_normalized. */
const email = z
  .string({ error: "El correo es obligatorio" })
  .trim()
  .toLowerCase()
  .max(254, "El correo no puede exceder 254 caracteres")
  .pipe(z.email("Escribe un correo válido"));

const role = z.enum(ROLES, { error: "El rol debe ser EMPLOYEE, MANAGER o HR" });

/** Earliest hire date accepted: anything before is a typo. */
export const HIRE_DATE_MIN = "1950-01-01";

/**
 * A real calendar date from 1950 up to one year ahead (an employee may be
 * registered before their first day). The upper bound is checked against
 * the server's clock in the service, not here, so it never goes stale.
 */
const hireDate = isoDate.refine((date) => date.getUTCFullYear() >= 1950, "La fecha de ingreso no puede ser anterior a 1950");

const id = (label: string) => z.string({ error: `${label} es obligatorio` }).trim().min(1, `${label} es obligatorio`).max(64, `${label} inválido`);

export const createEmployeeSchema = z
  .object({
    email,
    firstName: name("El nombre"),
    lastName: name("Los apellidos"),
    role,
    departmentId: id("El departamento"),
    /** null = no manager: HR decides their requests. */
    managerId: id("El jefe").nullable(),
    hireDate,
  })
  .strict();

export const updateEmployeeSchema = z
  .object({
    email: email.optional(),
    firstName: name("El nombre").optional(),
    lastName: name("Los apellidos").optional(),
    role: role.optional(),
    departmentId: id("El departamento").optional(),
    managerId: id("El jefe").nullable().optional(),
    hireDate: hireDate.optional(),
    /** Optimistic concurrency, as in updateLeaveTypeSchema. */
    expectedUpdatedAt: z.iso.datetime({ error: "expectedUpdatedAt debe ser una fecha ISO" }).optional(),
  })
  .strict()
  .refine(
    ({ expectedUpdatedAt: _expected, ...fields }) => Object.values(fields).some((value) => value !== undefined),
    { message: "Indica al menos un campo a cambiar" },
  );

/** Body of deactivate / reactivate: only the optimistic-concurrency check. */
export const employeeStateChangeSchema = z
  .object({ expectedUpdatedAt: z.iso.datetime({ error: "expectedUpdatedAt debe ser una fecha ISO" }).optional() })
  .strict();

export const EMPLOYEE_PAGE_SIZE_DEFAULT = 20;
export const EMPLOYEE_PAGE_SIZE_MAX = 100;

export const employeesQuerySchema = z
  .object({
    /** Words matched against first name, last name and email (all must match). */
    q: z.string().trim().max(100, "La búsqueda no puede exceder 100 caracteres").optional(),
    departmentId: id("El departamento").optional(),
    role: role.optional(),
    /** Default: only active employees. */
    status: z.enum(["active", "inactive", "all"], { error: "El estado debe ser active, inactive o all" }).default("active"),
    page: z.coerce.number().int("La página debe ser un número entero").min(1, "La página debe ser al menos 1").max(10_000).default(1),
    pageSize: z.coerce
      .number()
      .int("El tamaño de página debe ser un número entero")
      .min(1, "El tamaño de página debe ser al menos 1")
      .max(EMPLOYEE_PAGE_SIZE_MAX, `El tamaño de página no puede exceder ${EMPLOYEE_PAGE_SIZE_MAX}`)
      .default(EMPLOYEE_PAGE_SIZE_DEFAULT),
  })
  .strict();

export const hireDateImpactQuerySchema = z.object({ hireDate }).strict();

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type EmployeesQuery = z.infer<typeof employeesQuerySchema>;
