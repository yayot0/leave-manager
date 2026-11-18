import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { PendingApproval } from "@/api/types";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildPendingApproval, buildUser, PERSONAL_TYPE } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

function mockPendingApprovals(requests: PendingApproval[]) {
  server.use(http.get("/api/leave-requests/pending-approvals", () => HttpResponse.json({ leaveRequests: requests })));
}

const OVERDUE = buildPendingApproval({
  id: "req-overdue",
  startDate: "2026-11-16",
  endDate: "2026-11-17",
  businessDays: 2,
  requester: { id: "u-carlos", firstName: "Carlos", lastName: "Ruiz" },
  isOverdue: true,
});
const UPCOMING = buildPendingApproval({
  id: "req-upcoming",
  leaveType: PERSONAL_TYPE,
  requester: { id: "u-ana", firstName: "Ana", lastName: "García" },
});

function menuLink() {
  const nav = screen.getByRole("navigation", { name: "Principal" });
  return within(nav).getByRole("link", { name: /^Aprobaciones/ });
}

describe("ApprovalsPage", () => {
  it("lists who asks, type, dates and business days, overdue first and marked with text", async () => {
    mockSession(buildUser("MANAGER"));
    mockPendingApprovals([OVERDUE, UPCOMING]);
    renderApp("/aprobaciones");

    const table = await screen.findByRole("table");
    const [, first, second] = within(table).getAllByRole("row");
    expect(first).toHaveTextContent("Carlos Ruiz");
    expect(first).toHaveTextContent("Vacaciones");
    // Date-only values stay on their own day in Monterrey (tests run with TZ=America/Monterrey).
    expect(first).toHaveTextContent(/16 nov\.? 2026 al 17 nov\.? 2026/);
    expect(within(first).getByText("2")).toBeInTheDocument();
    expect(within(first).getByText("Vencida")).toBeInTheDocument();
    expect(second).toHaveTextContent("Ana García");
    expect(second).toHaveTextContent("Permiso personal");
    expect(within(second).queryByText("Vencida")).not.toBeInTheDocument();
    expect(screen.getByText("1 solicitud ya empezó y sigue pendiente; aparece primero.")).toBeInTheDocument();
  });

  it("shows cards for phones with the same data", async () => {
    mockSession(buildUser("MANAGER"));
    mockPendingApprovals([OVERDUE, UPCOMING]);
    renderApp("/aprobaciones");

    const cards = await screen.findByRole("list", { name: "Solicitudes por revisar" });
    const items = within(cards).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Carlos Ruiz");
    expect(items[0]).toHaveTextContent("Vencida");
    expect(items[0]).toHaveTextContent("2 días hábiles");
  });

  it("links each request to its detail with a descriptive name", async () => {
    mockSession(buildUser("MANAGER"));
    mockPendingApprovals([UPCOMING]);
    renderApp("/aprobaciones");

    const table = await screen.findByRole("table");
    const link = within(table).getByRole("link", { name: /Revisar solicitud de Ana García: Permiso personal/ });
    expect(link).toHaveAttribute("href", "/solicitudes/req-upcoming");
  });

  it("shows a friendly empty state", async () => {
    mockSession(buildUser("MANAGER"));
    renderApp("/aprobaciones");

    expect(await screen.findByRole("heading", { level: 2, name: "No tienes solicitudes por revisar" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows loading and then errors with Reintentar", async () => {
    mockSession(buildUser("HR"));
    const gate = deferred();
    server.use(
      http.get("/api/leave-requests/pending-approvals", async () => {
        await gate.promise;
        return HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 });
      }),
    );
    const { user } = renderApp("/aprobaciones");

    expect(await screen.findByText("Cargando solicitudes por revisar…")).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar las solicitudes por revisar");

    mockPendingApprovals([UPCOMING]);
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});

describe("pending approvals counter in the menu", () => {
  it("shows how many requests wait, with an accessible text", async () => {
    mockSession(buildUser("MANAGER"));
    mockPendingApprovals([OVERDUE, UPCOMING]);
    renderApp("/saldo");

    await waitFor(() => expect(menuLink()).toHaveAccessibleName("Aprobaciones (2 pendientes)"));
    expect(within(menuLink()).getByText("2")).toHaveAttribute("aria-hidden", "true");
  });

  it("uses the singular for one", async () => {
    mockSession(buildUser("HR"));
    mockPendingApprovals([UPCOMING]);
    renderApp("/saldo");

    await waitFor(() => expect(menuLink()).toHaveAccessibleName("Aprobaciones (1 pendiente)"));
  });

  it("shows nothing at zero", async () => {
    mockSession(buildUser("MANAGER"));
    renderApp("/aprobaciones");

    await screen.findByRole("heading", { level: 2, name: "No tienes solicitudes por revisar" });
    expect(menuLink()).toHaveAccessibleName("Aprobaciones");
  });

  it("is never requested for employees", async () => {
    mockSession(buildUser("EMPLOYEE"));
    let calls = 0;
    server.use(
      http.get("/api/leave-requests/pending-approvals", () => {
        calls++;
        return HttpResponse.json({ leaveRequests: [] });
      }),
    );
    renderApp("/saldo");

    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });
    expect(calls).toBe(0);
  });
});
