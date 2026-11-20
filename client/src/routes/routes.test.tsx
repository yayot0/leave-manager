import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildUser, VALID_PASSWORD } from "@/test/fixtures";
import { sessionQueryKey } from "@/auth/session";

function menuLinks(): string[] {
  // Desktop sidebar (the mobile menu is closed and not rendered).
  const nav = screen.getByRole("navigation", { name: "Principal" });
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

describe("protected routes", () => {
  it("sends a visitor without session to login, remembering the page", async () => {
    const { router } = renderApp("/solicitudes");

    expect(await screen.findByRole("heading", { level: 1, name: "Iniciar sesión" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.state).toEqual({ from: "/solicitudes" });
  });

  it("shows a loading state while the session loads", async () => {
    mockSession(buildUser("EMPLOYEE"));
    renderApp("/saldo");

    expect(screen.getByRole("status")).toHaveTextContent("Cargando sesión…");
    expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
  });

  it("shows an error with retry when the session cannot be loaded", async () => {
    server.use(http.get("/api/auth/me", () => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 })));
    const { user } = renderApp("/saldo");

    expect(await screen.findByRole("heading", { name: "No se pudo cargar tu sesión" })).toBeInTheDocument();

    mockSession(buildUser("EMPLOYEE"));
    await user.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
  });

  it("redirects / to Mi saldo", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { router } = renderApp("/");

    expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/saldo");
  });

  it("redirects a logged-in user away from login", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { router } = renderApp("/login");

    expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/saldo");
  });

  describe("menu and access by role", () => {
    it("EMPLOYEE sees only its three sections and cannot open Aprobaciones", async () => {
      mockSession(buildUser("EMPLOYEE"));
      renderApp("/aprobaciones");

      expect(await screen.findByRole("heading", { level: 1, name: "No tienes acceso a esta sección" })).toBeInTheDocument();
      expect(menuLinks()).toEqual(["Mi saldo", "Mis solicitudes", "Nueva solicitud", "Mi cuenta"]);
    });

    it("MANAGER also sees Aprobaciones but cannot open Administración", async () => {
      mockSession(buildUser("MANAGER"));
      renderApp("/administracion");

      expect(await screen.findByRole("heading", { level: 1, name: "No tienes acceso a esta sección" })).toBeInTheDocument();
      expect(menuLinks()).toEqual(["Mi saldo", "Mis solicitudes", "Nueva solicitud", "Aprobaciones", "Mi cuenta"]);
    });

    it("HR sees every section", async () => {
      mockSession(buildUser("HR"));
      renderApp("/administracion");

      expect(await screen.findByRole("heading", { level: 1, name: "Administración" })).toBeInTheDocument();
      expect(menuLinks()).toEqual(["Mi saldo", "Mis solicitudes", "Nueva solicitud", "Aprobaciones", "Administración", "Mi cuenta"]);
    });

    it("MANAGER cannot open the administration sub-pages, and the API is never called", async () => {
      mockSession(buildUser("MANAGER"));
      let hrCalls = 0;
      server.use(
        http.get("/api/hr/*", () => {
          hrCalls++;
          return HttpResponse.json({ error: "No autorizado" }, { status: 403 });
        }),
      );
      renderApp("/administracion/festivos");

      expect(await screen.findByRole("heading", { level: 1, name: "No tienes acceso a esta sección" })).toBeInTheDocument();
      expect(hrCalls).toBe(0);
    });

    it("HR opens an administration sub-page with Administración still marked in the menu", async () => {
      mockSession(buildUser("HR"));
      renderApp("/administracion/departamentos");

      expect(await screen.findByRole("heading", { level: 1, name: "Departamentos" })).toBeInTheDocument();
      const nav = screen.getByRole("navigation", { name: "Principal" });
      // Highlighted as the current section, but only the sub-menu says "page" (one current page).
      expect(within(nav).getByRole("link", { name: "Administración" })).toHaveAttribute("aria-current", "true");
      const subnav = screen.getByRole("navigation", { name: "Secciones de administración" });
      expect(within(subnav).getByRole("link", { name: "Departamentos" })).toHaveAttribute("aria-current", "page");
    });

    it("an unknown administration sub-path is not found for HR (default deny)", async () => {
      mockSession(buildUser("HR"));
      renderApp("/administracion/otra");

      expect(await screen.findByRole("heading", { level: 1, name: "Página no encontrada" })).toBeInTheDocument();
    });

    it("marks the current section in the menu", async () => {
      mockSession(buildUser("EMPLOYEE"));
      renderApp("/solicitudes");

      await screen.findByRole("heading", { level: 1, name: "Mis solicitudes" });
      const nav = screen.getByRole("navigation", { name: "Principal" });
      expect(within(nav).getByRole("link", { name: "Mis solicitudes" })).toHaveAttribute("aria-current", "page");
      expect(within(nav).getByRole("link", { name: "Nueva solicitud" })).not.toHaveAttribute("aria-current");
    });
  });

  it("shows the user's name and role", async () => {
    mockSession(buildUser("MANAGER", { firstName: "Luis", lastName: "Pérez" }));
    renderApp("/saldo");

    expect(await screen.findByText("Luis Pérez")).toBeInTheDocument();
    expect(screen.getByText("Jefe de área")).toBeInTheDocument();
  });

  it("shows a not found page for unknown paths", async () => {
    mockSession(buildUser("EMPLOYEE"));
    renderApp("/no-existe");

    expect(await screen.findByRole("heading", { level: 1, name: "Página no encontrada" })).toBeInTheDocument();
  });

  it("logs out and returns to login", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { user, router } = renderApp("/saldo");

    await user.click(await screen.findByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Iniciar sesión" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    // A deliberate logout does not remember the page for the next person.
    expect(router.state.location.state).toBeNull();
  });

  it("keeps the page on screen when a background refresh of the session fails", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { queryClient } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });

    server.use(http.get("/api/auth/me", () => HttpResponse.error()));
    await queryClient.refetchQueries({ queryKey: sessionQueryKey });

    expect(queryClient.getQueryState(sessionQueryKey)?.status).toBe("error");
    expect(screen.getByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
    expect(screen.queryByText("No se pudo cargar tu sesión")).not.toBeInTheDocument();
  });

  it("keeps the session and shows an error when logout fails", async () => {
    mockSession(buildUser("EMPLOYEE"));
    server.use(http.post("/api/auth/logout", () => HttpResponse.error()));
    const { user, router } = renderApp("/saldo");

    await user.click(await screen.findByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cerrar la sesión");
    expect(router.state.location.pathname).toBe("/saldo");
  });

  it("returns to login when any API call answers 401 mid-session", async () => {
    mockSession(buildUser("EMPLOYEE"));
    server.use(http.get("/api/leave-requests/mine", () => HttpResponse.json({ error: "No autenticado" }, { status: 401 })));
    // The page's own request gets the 401.
    const { router } = renderApp("/solicitudes");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.state).toEqual({ from: "/solicitudes" });
  });

  it("forgets the deliberate logout on the next login, so a later expiry remembers the page", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { user, router } = renderApp("/saldo");
    await user.click(await screen.findByRole("button", { name: "Cerrar sesión" }));
    await screen.findByRole("heading", { level: 1, name: "Iniciar sesión" });

    // Log in again (the default login handler answers with an EMPLOYEE).
    await user.type(screen.getByLabelText("Correo electrónico"), "employee@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), VALID_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });

    // Now the session expires while on another page.
    server.use(http.get("/api/leave-requests/mine", () => HttpResponse.json({ error: "No autenticado" }, { status: 401 })));
    await user.click(within(screen.getByRole("navigation", { name: "Principal" })).getByRole("link", { name: "Mis solicitudes" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.state).toEqual({ from: "/solicitudes" });
  });
});
