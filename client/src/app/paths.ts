/**
 * URL paths of the app. Kept apart from navigation.ts (which imports every
 * page) so non-UI code, like the session hooks, can use them.
 */
export const ROUTES = {
  login: "/login",
  balance: "/saldo",
  myRequests: "/solicitudes",
  newRequest: "/solicitudes/nueva",
  requestDetail: "/solicitudes/:id",
  approvals: "/aprobaciones",
  admin: "/administracion",
  adminDepartments: "/administracion/departamentos",
  adminLeaveTypes: "/administracion/tipos-de-permiso",
  adminHolidays: "/administracion/festivos",
  adminEmployees: "/administracion/empleados",
  adminEmployeeDetail: "/administracion/empleados/:id",
  /** The only page a temporary-password session can open. */
  account: "/mi-cuenta",
} as const;

export const HOME_ROUTE = ROUTES.balance;

/** Path of a request's detail page; the id is escaped like any URL segment. */
export function requestDetailPath(id: string): string {
  return `/solicitudes/${encodeURIComponent(id)}`;
}

/**
 * Router state a link passes when it opens a detail from Aprobaciones, so the
 * detail's "Volver" goes back there. Only this literal value is recognized:
 * the state never becomes a URL, so it cannot redirect anywhere else.
 */
export const FROM_APPROVALS_STATE = { from: "approvals" } as const;

export function cameFromApprovals(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as { from?: unknown }).from === "approvals";
}

/** Path of an employee's detail page (HR); the id is escaped like any URL segment. */
export function employeeDetailPath(id: string): string {
  return `/administracion/empleados/${encodeURIComponent(id)}`;
}

/**
 * Router state of a link from an employee's detail to one of their requests
 * (e.g. the overdue ones that block a deactivation): the request's "Volver"
 * goes back to that employee. Only this shape is recognized, and only the
 * id travels: the path is rebuilt with employeeDetailPath (never a URL).
 */
export function fromEmployeeState(employeeId: string) {
  return { from: "employee", employeeId } as const;
}

export function employeeFromState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const { from, employeeId } = state as { from?: unknown; employeeId?: unknown };
  return from === "employee" && typeof employeeId === "string" && employeeId !== "" ? employeeId : null;
}

/** The list filters that live in the URL (see EmployeesPage). */
export const EMPLOYEE_FILTER_KEYS = ["q", "departmentId", "role", "status", "page"] as const;

/**
 * Router state of a link from the employee list to a detail: the detail's
 * "Volver" returns to the list WITH its filters. Only known filter keys
 * survive, and they are re-serialized by URLSearchParams onto a fixed path,
 * so the state can never send the user anywhere else.
 */
export function fromEmployeeListState(search: string) {
  return { from: "employees", search: sanitizeEmployeeSearch(search) } as const;
}

function sanitizeEmployeeSearch(search: string): string {
  const source = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of EMPLOYEE_FILTER_KEYS) {
    const value = source.get(key);
    if (value !== null && value.length <= 100) kept.set(key, value);
  }
  const text = kept.toString();
  return text === "" ? "" : `?${text}`;
}

/** "Volver" target of an employee's detail: the list, with its filters if the state carries them. */
export function employeeListBackPath(state: unknown): string {
  if (typeof state === "object" && state !== null) {
    const { from, search } = state as { from?: unknown; search?: unknown };
    if (from === "employees" && typeof search === "string") {
      return `${ROUTES.adminEmployees}${sanitizeEmployeeSearch(search)}`;
    }
  }
  return ROUTES.adminEmployees;
}
