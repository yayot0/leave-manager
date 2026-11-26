import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import type { User } from "@/api/types";
import { buildBalance, buildPreview, buildUser, PERSONAL_TYPE, VACATION_TYPE, VALID_PASSWORD } from "./fixtures";

/**
 * MSW intercepts the real `fetch` calls at the network level, so tests run
 * the actual API client (URLs, cookies option, JSON parsing, 401/429
 * handling). Handlers answer with the same shapes as the Express API.
 *
 * Default state: nobody is logged in. A test logs a user in with
 * `mockSession(user)` or overrides any endpoint with `server.use(...)`.
 * The data endpoints answer with a neutral default (a balance, no requests,
 * two leave types, a clean preview, nothing to approve) so pages render without extra setup.
 */
export const handlers = [
  http.get("/api/auth/me", () => HttpResponse.json({ error: "No autenticado" }, { status: 401 })),

  http.post("/api/auth/login", async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string };
    if (body.password !== VALID_PASSWORD) {
      return HttpResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
    }
    return HttpResponse.json({ user: buildUser("EMPLOYEE", { email: body.email ?? "" }) });
  }),

  http.post("/api/auth/logout", () => HttpResponse.json({ message: "Sesión cerrada" })),

  http.get("/api/me/balance", () => HttpResponse.json({ balance: buildBalance() })),
  http.get("/api/leave-types", () => HttpResponse.json({ leaveTypes: [VACATION_TYPE, PERSONAL_TYPE] })),
  http.get("/api/leave-requests/mine", () => HttpResponse.json({ leaveRequests: [] })),
  http.get("/api/leave-requests/pending-approvals", () => HttpResponse.json({ leaveRequests: [] })),
  // HR catalogs: empty by default.
  http.get("/api/hr/departments", () => HttpResponse.json({ departments: [] })),
  http.get("/api/hr/leave-types", () => HttpResponse.json({ leaveTypes: [] })),
  http.get("/api/hr/holidays", () => HttpResponse.json({ holidays: [] })),
  http.get("/api/hr/holidays/impact", () =>
    HttpResponse.json({
      affectedRequests: 0,
      breakdown: { countingBalance: 0, notCountingBalance: 0, past: 0, upcoming: 0 },
    }),
  ),
  http.get("/api/leave-requests/preview", () => HttpResponse.json({ preview: buildPreview() })),
  // Employees: an empty first page and nobody to pick as manager. A detail
  // (/api/hr/employees/:id) has no default: mock it in each test.
  http.get("/api/hr/employees", () =>
    HttpResponse.json({ employees: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }),
  ),
  http.get("/api/hr/employees/manager-options", () => HttpResponse.json({ managers: [] })),
];

export const server = setupServer(...handlers);

export function mockSession(user: User): void {
  server.use(http.get("/api/auth/me", () => HttpResponse.json({ user })));
}

// Static paths that "/api/leave-requests/:id" would also match.
const LEAVE_REQUEST_COLLECTIONS = new Set(["mine", "preview", "pending-approvals"]);

/**
 * Mocks GET /api/leave-requests/:id only. A bare `http.get(".../:id")` set
 * with `server.use` would win over the default handlers and also answer
 * /mine and /preview, hiding bugs; returning nothing here lets MSW fall
 * through to the handler of those paths.
 */
export function mockDetail(resolve: (id: string, request: Request) => Response | Promise<Response>): void {
  server.use(
    http.get("/api/leave-requests/:id", ({ params, request }) => {
      const id = String(params.id);
      if (LEAVE_REQUEST_COLLECTIONS.has(id)) {
        return undefined;
      }
      return resolve(id, request);
    }),
  );
}

// Static paths that "/api/hr/employees/:id" would also match.
const EMPLOYEE_COLLECTIONS = new Set(["manager-options"]);

/**
 * Mocks GET /api/hr/employees/:id only (same reason as mockDetail: a bare
 * handler would also answer /manager-options). Returns the ids asked for.
 */
export function mockEmployeeDetail(resolve: (id: string, request: Request) => Response | Promise<Response>): string[] {
  const asked: string[] = [];
  server.use(
    http.get("/api/hr/employees/:id", ({ params, request }) => {
      const id = String(params.id);
      if (EMPLOYEE_COLLECTIONS.has(id)) {
        return undefined;
      }
      asked.push(id);
      return resolve(id, request);
    }),
  );
  return asked;
}
