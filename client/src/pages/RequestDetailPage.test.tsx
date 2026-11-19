import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { LeaveRequestDetail } from "@/api/types";
import { renderApp } from "@/test/render";
import { mockDetail, mockSession, server } from "@/test/server";
import { buildDetail, buildUser, EMPLOYEE_PERSON, MANAGER_PERSON, VACATION_TYPE } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

function mockDetailData(detail: LeaveRequestDetail) {
  mockDetail(() => HttpResponse.json({ leaveRequest: detail }));
}

function field(label: string): string {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent ?? "";
}

describe("RequestDetailPage", () => {
  it("is reachable by every role, without a menu entry", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockDetailData(buildDetail());
    renderApp("/solicitudes/req-1");

    expect(await screen.findByRole("heading", { level: 1, name: "Detalle de solicitud" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Principal" });
    expect(within(nav).queryByRole("link", { name: "Detalle de solicitud" })).not.toBeInTheDocument();
  });

  it("asks the API with the escaped id", async () => {
    mockSession(buildUser("EMPLOYEE"));
    let requestedPath = "";
    mockDetail((_id, request) => {
      requestedPath = new URL(request.url).pathname;
      return HttpResponse.json({ leaveRequest: buildDetail() });
    });
    // The router decodes "%3F" back to "?" in the param; the API call must re-escape it.
    renderApp("/solicitudes/a%3Fb");

    await screen.findByRole("heading", { level: 2, name: "Vacaciones" });
    expect(requestedPath).toBe("/api/leave-requests/a%3Fb");
  });

  it("shows a loading state, keeping the page heading", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const gate = deferred();
    mockDetail(async () => {
      await gate.promise;
      return HttpResponse.json({ leaveRequest: buildDetail() });
    });
    renderApp("/solicitudes/req-1");

    expect(await screen.findByText("Cargando la solicitud…")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Detalle de solicitud" })).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByRole("heading", { level: 2, name: "Vacaciones" })).toBeInTheDocument();
  });

  it("shows the request data with date-only values on their own day", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockDetailData(buildDetail({ startDate: "2027-01-01", endDate: "2027-01-04", businessDays: 2, reason: "Viaje familiar" }));
    renderApp("/solicitudes/req-1");

    await screen.findByRole("heading", { level: 2, name: "Vacaciones" });
    expect(field("Del")).toBe("1 de enero de 2027");
    expect(field("Al")).toBe("4 de enero de 2027");
    expect(field("Días hábiles")).toBe("2");
    expect(field("Motivo")).toBe("Viaje familiar");
    expect(screen.getByText("Pendiente")).toBeInTheDocument();
  });

  it("shows the event history as a timeline, with notes and local times", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockDetailData(
      buildDetail({
        status: "CANCELLED",
        decider: MANAGER_PERSON,
        decidedAt: "2026-11-12T03:00:00.000Z",
        decisionNote: "Que descanses",
        permissions: { canApprove: false, canReject: false, canCancel: false },
        events: [
          { id: "e1", action: "CREATED", note: null, createdAt: "2026-11-10T16:00:00.000Z", actor: EMPLOYEE_PERSON },
          { id: "e2", action: "APPROVED", note: "Que descanses", createdAt: "2026-11-12T03:00:00.000Z", actor: MANAGER_PERSON },
          { id: "e3", action: "CANCELLED", note: "Cambié de planes", createdAt: "2026-11-13T15:30:00.000Z", actor: EMPLOYEE_PERSON },
        ],
      }),
    );
    renderApp("/solicitudes/req-1");

    const timeline = await screen.findByRole("list", { name: "Historial de la solicitud" });
    const items = within(timeline).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Solicitud creada");
    expect(items[0]).toHaveTextContent("Ana García (tú)");
    expect(items[1]).toHaveTextContent("Aprobada");
    expect(items[1]).toHaveTextContent("Luis Pérez");
    // 03:00 UTC on Nov 12 is still Nov 11 in Monterrey.
    expect(items[1]).toHaveTextContent(/11 nov\.? 2026/);
    expect(items[1]).toHaveTextContent("“Que descanses”");
    expect(items[2]).toHaveTextContent("Cancelada");
    expect(items[2]).toHaveTextContent("“Cambié de planes”");

    // Approved first, then cancelled: the decider is still shown.
    expect(field("Aprobada por")).toContain("Luis Pérez");
    expect(screen.queryByRole("button", { name: /Cancelar/ })).not.toBeInTheDocument();
  });

  it("uses the request's own copy of 'descuenta', not the type's current value", async () => {
    mockSession(buildUser("EMPLOYEE"));
    // Created when Vacaciones counted; HR changed the type afterwards.
    mockDetailData(
      buildDetail({
        countsAgainstVacationBalance: true,
        leaveType: { ...VACATION_TYPE, countsAgainstVacationBalance: false },
      }),
    );
    const { user } = renderApp("/solicitudes/req-1");

    await screen.findByRole("heading", { level: 2, name: "Vacaciones" });
    expect(field("Descuenta de tus vacaciones")).toBe("Sí");
    await user.click(screen.getByRole("button", { name: /Cancelar solicitud/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Los días que tenía apartados volverán a tu saldo.");
  });

  it("shows a not-found message for a 404 (hidden or nonexistent)", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockDetail(() => HttpResponse.json({ error: "Solicitud no encontrada" }, { status: 404 }));
    renderApp("/solicitudes/ajena");

    expect(await screen.findByRole("heading", { level: 2, name: "No encontramos esta solicitud" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Mis solicitudes" })).toHaveAttribute("href", "/solicitudes");
  });

  it("shows other errors with Reintentar", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockDetail(() => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 }));
    const { user } = renderApp("/solicitudes/req-1");

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar la solicitud");
    mockDetailData(buildDetail());
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Vacaciones" })).toBeInTheDocument();
  });

  it("cancels an approved request that has not started and shows the updated detail", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const approved = buildDetail({
      status: "APPROVED",
      decider: MANAGER_PERSON,
      decidedAt: "2026-11-11T18:00:00.000Z",
    });
    const cancelled = buildDetail({
      ...approved,
      status: "CANCELLED",
      permissions: { canApprove: false, canReject: false, canCancel: false },
      events: [
        ...approved.events,
        { id: "e9", action: "CANCELLED", note: null, createdAt: "2026-11-17T18:00:00.000Z", actor: EMPLOYEE_PERSON },
      ],
    });
    let current = approved;
    mockDetail(() => HttpResponse.json({ leaveRequest: current }));
    server.use(
      http.post("/api/leave-requests/:id/cancel", () => {
        current = cancelled;
        return HttpResponse.json({ leaveRequest: cancelled });
      }),
    );
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: /Cancelar solicitud/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Los días volverán a tu saldo.");
    await user.click(within(dialog).getByRole("button", { name: "Sí, cancelar solicitud" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Cancelada", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancelar solicitud/ })).not.toBeInTheDocument();
    const timeline = screen.getByRole("list", { name: "Historial de la solicitud" });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 1, name: "Detalle de solicitud" })).toHaveFocus();
  });
});
