import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildUser, VALID_PASSWORD } from "@/test/fixtures";
import type { Role, User } from "@/api/types";

function temporaryUser(role: Role = "EMPLOYEE"): User {
  return buildUser(role, { mustChangePassword: true });
}

// `resetHandlers` (in setup) does not remove event listeners.
afterEach(() => server.events.removeAllListeners());

/** Counts requests to an endpoint (any method), letting MSW keep answering with the default handlers. */
function countRequests(path: string): { count: number } {
  const counter = { count: 0 };
  server.events.on("request:start", ({ request }) => {
    if (new URL(request.url).pathname === path) counter.count++;
  });
  return counter;
}

async function expectAccountOnly(router: ReturnType<typeof renderApp>["router"]) {
  expect(await screen.findByRole("heading", { level: 1, name: "Mi cuenta" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/mi-cuenta");
  expect(screen.getByText("Crea tu propia contraseña para continuar")).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Principal" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Abrir menú" })).not.toBeInTheDocument();
  for (const label of ["Mi saldo", "Mis solicitudes", "Nueva solicitud", "Aprobaciones", "Administración"]) {
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
  }
  expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
}

describe("temporary-password session", () => {
  it.each<[string, Role]>([
    ["/saldo", "EMPLOYEE"],
    ["/solicitudes", "EMPLOYEE"],
    ["/solicitudes/nueva", "EMPLOYEE"],
    ["/solicitudes/req-1", "EMPLOYEE"],
    ["/aprobaciones", "MANAGER"],
    ["/administracion", "HR"],
    ["/administracion/festivos", "HR"],
    ["/", "EMPLOYEE"],
    ["/no-existe", "EMPLOYEE"],
  ])("%s (%s) ends on Mi cuenta, without menu and with only 'Cerrar sesión'", async (path, role) => {
    mockSession(temporaryUser(role));
    const { router } = renderApp(path);

    await expectAccountOnly(router);
  });

  it("/mi-cuenta with different case or a trailing slash is still allowed (no redirect loop)", async () => {
    mockSession(temporaryUser());
    const { router } = renderApp("/Mi-Cuenta/");

    expect(await screen.findByRole("heading", { level: 1, name: "Mi cuenta" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/Mi-Cuenta/");
  });

  it("does not call any data endpoint the API would answer with 403 (pending approvals, balance, HR)", async () => {
    mockSession(temporaryUser("HR"));
    const pending = countRequests("/api/leave-requests/pending-approvals");
    const balance = countRequests("/api/me/balance");
    const departments = countRequests("/api/hr/departments");
    const { router } = renderApp("/administracion/departamentos");

    await expectAccountOnly(router);
    expect(pending.count).toBe(0);
    expect(balance.count).toBe(0);
    expect(departments.count).toBe(0);
  });

  it("'Cerrar sesión' works from the temporary session", async () => {
    mockSession(temporaryUser());
    const { user, router } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });

    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Iniciar sesión" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("after changing it, the menu appears, the notice goes away and 'Ir a Mi saldo' leads home", async () => {
    mockSession(temporaryUser("MANAGER"));
    const pending = countRequests("/api/leave-requests/pending-approvals");
    let body: unknown;
    server.use(
      http.post("/api/auth/change-password", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ user: buildUser("MANAGER", { mustChangePassword: false }) });
      }),
    );
    const { user, router } = renderApp("/aprobaciones");
    await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });

    await user.type(screen.getByLabelText("Contraseña temporal"), "temporal-de-rh");
    await user.type(screen.getByLabelText("Contraseña nueva"), "una frase larga que solo yo conozco");
    await user.type(screen.getByLabelText("Confirma la contraseña nueva"), "una frase larga que solo yo conozco");
    await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Listo: ya tienes tu propia contraseña y puedes usar la aplicación.",
    );
    expect(body).toEqual({ currentPassword: "temporal-de-rh", newPassword: "una frase larga que solo yo conozco" });
    const nav = await screen.findByRole("navigation", { name: "Principal" });
    expect(within(nav).getByRole("link", { name: "Aprobaciones" })).toBeInTheDocument();
    expect(screen.queryByText("Crea tu propia contraseña para continuar")).not.toBeInTheDocument();
    // The first field now is the normal one.
    expect(screen.getByLabelText("Contraseña actual")).toBeInTheDocument();
    // Now that the menu exists, the approvals counter is requested.
    await waitFor(() => expect(pending.count).toBeGreaterThan(0));

    await user.click(screen.getByRole("link", { name: "Ir a Mi saldo" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/saldo");
  });

  it("if the change fails, the app stays locked", async () => {
    mockSession(temporaryUser());
    server.use(
      http.post("/api/auth/change-password", () =>
        HttpResponse.json({ error: "x", code: "PASSWORD_TOO_COMMON" }, { status: 400 }),
      ),
    );
    const { user, router } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });

    await user.type(screen.getByLabelText("Contraseña temporal"), "temporal-de-rh");
    await user.type(screen.getByLabelText("Contraseña nueva"), "contraseña123456");
    await user.type(screen.getByLabelText("Confirma la contraseña nueva"), "contraseña123456");
    await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

    await waitFor(() => expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute("aria-invalid", "true"));
    await expectAccountOnly(router);
  });
});

describe("login with a temporary password", () => {
  function mockTemporaryLogin() {
    server.use(
      http.post("/api/auth/login", async ({ request }) => {
        const { email } = (await request.json()) as { email: string };
        return HttpResponse.json({ user: buildUser("MANAGER", { email, mustChangePassword: true }) });
      }),
    );
  }

  async function logIn(user: ReturnType<typeof renderApp>["user"]) {
    await user.type(await screen.findByLabelText("Correo electrónico"), "luis@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), VALID_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));
  }

  it("goes to /mi-cuenta even when `from` points to an allowed page", async () => {
    mockTemporaryLogin();
    const { user, router } = renderApp({ pathname: "/login", state: { from: "/aprobaciones" } });

    await logIn(user);

    await expectAccountOnly(router);
  });

  it("goes to /mi-cuenta when a protected page sent the visitor to login", async () => {
    mockTemporaryLogin();
    const { user, router } = renderApp("/solicitudes");
    await screen.findByRole("heading", { level: 1, name: "Iniciar sesión" });
    expect(router.state.location.state).toEqual({ from: "/solicitudes" });

    await logIn(user);

    await expectAccountOnly(router);
  });

  it("a temporary session that opens /login is sent to /mi-cuenta", async () => {
    mockSession(temporaryUser());
    const { router } = renderApp("/login");

    await expectAccountOnly(router);
  });

  it("a normal login still honors `from` (regression)", async () => {
    const { user, router } = renderApp({ pathname: "/login", state: { from: "/solicitudes" } });

    await logIn(user);

    expect(await screen.findByRole("heading", { level: 1, name: "Mis solicitudes" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/solicitudes");
  });
});

describe("403 PASSWORD_CHANGE_REQUIRED mid-session", () => {
  it("refetches /api/auth/me and, if the password is now temporary, shows Mi cuenta", async () => {
    let sessionUser = buildUser("EMPLOYEE");
    let meCalls = 0;
    server.use(
      http.get("/api/auth/me", () => {
        meCalls++;
        return HttpResponse.json({ user: sessionUser });
      }),
      http.get("/api/me/balance", () => {
        // The cookie now belongs to a temporary-password account (e.g. another tab logged in).
        sessionUser = temporaryUser();
        return HttpResponse.json(
          { error: "Debes cambiar tu contraseña", code: "PASSWORD_CHANGE_REQUIRED" },
          { status: 403 },
        );
      }),
    );
    const { router } = renderApp("/saldo");

    await expectAccountOnly(router);
    expect(meCalls).toBeGreaterThanOrEqual(2);
  });

  it("works from a mutation too (a POST answered with the 403)", async () => {
    let sessionUser = buildUser("EMPLOYEE");
    server.use(
      http.get("/api/auth/me", () => HttpResponse.json({ user: sessionUser })),
      http.post("/api/auth/change-password", () => {
        sessionUser = temporaryUser();
        return HttpResponse.json({ error: "x", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403 });
      }),
    );
    const { user } = renderApp("/mi-cuenta");
    await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });

    await user.type(screen.getByLabelText("Contraseña actual"), "actual");
    await user.type(screen.getByLabelText("Contraseña nueva"), "una frase larga que solo yo conozco");
    await user.type(screen.getByLabelText("Confirma la contraseña nueva"), "una frase larga que solo yo conozco");
    await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

    expect(await screen.findByText("Crea tu propia contraseña para continuar")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña temporal")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Principal" })).not.toBeInTheDocument();
  });

  it("a 403 with another code (plain forbidden) does not refetch the session", async () => {
    let meCalls = 0;
    server.use(
      http.get("/api/auth/me", () => {
        meCalls++;
        return HttpResponse.json({ user: buildUser("EMPLOYEE") });
      }),
      http.get("/api/me/balance", () =>
        HttpResponse.json({ error: "No autorizado", code: "FORBIDDEN" }, { status: 403 }),
      ),
    );
    const { router } = renderApp("/saldo");

    expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
    // Let the balance request fail.
    await screen.findByRole("alert");
    expect(meCalls).toBe(1);
    expect(router.state.location.pathname).toBe("/saldo");
  });

  it("a 403 PASSWORD_CHANGE_REQUIRED whose /me still says the password is fine keeps the user on the page", async () => {
    let meCalls = 0;
    server.use(
      http.get("/api/auth/me", () => {
        meCalls++;
        return HttpResponse.json({ user: buildUser("EMPLOYEE") });
      }),
      http.get("/api/me/balance", () =>
        HttpResponse.json({ error: "x", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403 }),
      ),
    );
    const { router } = renderApp("/saldo");

    await waitFor(() => expect(meCalls).toBe(2));
    expect(screen.getByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/saldo");
    // No endless loop: one refetch per 403.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(meCalls).toBe(2);
  });

  it("when /me now returns ANOTHER user (another tab logged in), the previous user's cache is dropped", async () => {
    let sessionUser = buildUser("MANAGER", { id: "manager-1" });
    server.use(
      http.get("/api/auth/me", () => HttpResponse.json({ user: sessionUser })),
      http.get("/api/leave-requests/pending-approvals", () => {
        if (sessionUser.mustChangePassword) {
          return HttpResponse.json({ error: "x", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403 });
        }
        return HttpResponse.json({ leaveRequests: [] });
      }),
    );
    const { queryClient } = renderApp("/saldo");
    expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(1));

    // Another tab logs in as a temporary-password employee; the next request gets the 403.
    sessionUser = buildUser("EMPLOYEE", { id: "employee-2", mustChangePassword: true });
    await queryClient.refetchQueries({ queryKey: ["leave-requests"] });

    expect(await screen.findByText("Crea tu propia contraseña para continuar")).toBeInTheDocument();
    // Only the session survives: nothing cached for manager-1 is left.
    const remaining = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));
    expect(remaining).toEqual([JSON.stringify(["auth", "me"])]);
  });
});
