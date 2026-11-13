import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildUser } from "@/test/fixtures";
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
      expect(menuLinks()).toEqual(["Mi saldo", "Mis solicitudes", "Nueva solicitud"]);
    });

    it("MANAGER also sees Aprobaciones but cannot open Administración", async () => {
      mockSession(buildUser("MANAGER"));
      renderApp("/administracion");

      expect(await screen.findByRole("heading", { level: 1, name: "No tienes acceso a esta sección" })).toBeInTheDocument();
      expect(menuLinks()).toEqual(["Mi saldo", "Mis solicitudes", "Nueva solicitud", "Aprobaciones"]);
    });

    it("HR sees every section", async () => {
      mockSession(buildUser("HR"));
      renderApp("/administracion");

      expect(await screen.findByRole("heading", { level: 1, name: "Administración" })).toBeInTheDocument();
      expect(menuLinks()).toEqual(["Mi saldo", "Mis solicitudes", "Nueva solicitud", "Aprobaciones", "Administración"]);
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
    const { router } = renderApp("/solicitudes");
    await screen.findByRole("heading", { level: 1, name: "Mis solicitudes" });

    // No page calls this endpoint yet: call the client directly, as a page would.
    const { apiFetch } = await import("@/api/client");
    await expect(apiFetch("/leave-requests/mine")).rejects.toMatchObject({ status: 401 });

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.state).toEqual({ from: "/solicitudes" });
  });
});
