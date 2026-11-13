import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import type { User } from "@/api/types";
import { buildUser, VALID_PASSWORD } from "./fixtures";

/**
 * MSW intercepts the real `fetch` calls at the network level, so tests run
 * the actual API client (URLs, cookies option, JSON parsing, 401/429
 * handling). Handlers answer with the same shapes as the Express API.
 *
 * Default state: nobody is logged in. A test logs a user in with
 * `mockSession(user)` or overrides any endpoint with `server.use(...)`.
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
];

export const server = setupServer(...handlers);

export function mockSession(user: User): void {
  server.use(http.get("/api/auth/me", () => HttpResponse.json({ user })));
}
