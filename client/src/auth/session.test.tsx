import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildUser, VALID_PASSWORD } from "@/test/fixtures";
import { sessionQueryKey } from "./session";

// Stand-ins for data a page would cache for the logged-in user.
const userDataKey = ["leave-requests", "mine"] as const;
const otherAuthKey = ["auth", "something-else"] as const;

function seedUserData(queryClient: QueryClient) {
  queryClient.setQueryData(userDataKey, [{ id: "req-1", note: "Viaje familiar" }]);
  queryClient.setQueryData(otherAuthKey, { secret: true });
}

function expectNoUserData(queryClient: QueryClient) {
  expect(queryClient.getQueryData(userDataKey)).toBeUndefined();
  // Exact-key match: other queries under "auth" are user data too.
  expect(queryClient.getQueryData(otherAuthKey)).toBeUndefined();
  // Mutations keep their variables (e.g. the login password) in memory.
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
}

describe("session cache isolation between users", () => {
  it("drops cached user data on logout", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { user, queryClient } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });
    seedUserData(queryClient);

    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByRole("heading", { level: 1, name: "Iniciar sesión" });

    expectNoUserData(queryClient);
    expect(queryClient.getQueryData(sessionQueryKey)).toBeNull();
  });

  it("drops cached user data when the session expires (401)", async () => {
    mockSession(buildUser("EMPLOYEE"));
    server.use(http.get("/api/leave-requests/mine", () => HttpResponse.json({ error: "No autenticado" }, { status: 401 })));
    const { router, queryClient } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });
    seedUserData(queryClient);

    await expect(apiFetch("/leave-requests/mine")).rejects.toMatchObject({ status: 401 });

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expectNoUserData(queryClient);
  });

  it("drops data left from a previous session when a new user logs in", async () => {
    const { user, queryClient } = renderApp("/login");
    await screen.findByRole("heading", { level: 1, name: "Iniciar sesión" });
    seedUserData(queryClient);

    await user.type(screen.getByLabelText("Correo electrónico"), "ana@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), VALID_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });

    expectNoUserData(queryClient);
    expect(queryClient.getQueryData(sessionQueryKey)).toMatchObject({ email: "ana@empresa.com" });
  });
});
