import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { LeaveRequestDetail, PendingApproval } from "@/api/types";
import { renderApp } from "@/test/render";
import { mockDetail, mockSession, server } from "@/test/server";
import { deferred } from "@/test/deferred";
import {
  buildDecidableDetail,
  buildDetail,
  buildPendingApproval,
  buildRequesterBalance,
  buildUser,
  MANAGER_PERSON,
} from "@/test/fixtures";

const MANAGER = buildUser("MANAGER", { id: MANAGER_PERSON.id, firstName: "Luis", lastName: "Pérez" });

function field(label: string): string {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent ?? "";
}

function decided(base: LeaveRequestDetail, status: "APPROVED" | "REJECTED", note: string | null): LeaveRequestDetail {
  return {
    ...base,
    status,
    decider: MANAGER_PERSON,
    decidedAt: "2026-11-18T18:00:00.000Z",
    decisionNote: note,
    requesterBalance: null,
    permissions: { canApprove: false, canReject: false, canCancel: false },
    events: [
      ...base.events,
      { id: "ev-2", action: status, note, createdAt: "2026-11-18T18:00:00.000Z", actor: MANAGER_PERSON },
    ],
  };
}

/**
 * A detail that changes when the action endpoint answers OK, plus the list
 * of pending approvals that empties after deciding (to check the refresh).
 */
function mockDecisionFlow(initial: LeaveRequestDetail) {
  let current = initial;
  let pending: PendingApproval[] = [buildPendingApproval({ id: initial.id })];
  const bodies: { action: string; body: unknown }[] = [];
  mockDetail(() => HttpResponse.json({ leaveRequest: current }));
  server.use(
    http.get("/api/leave-requests/pending-approvals", () => HttpResponse.json({ leaveRequests: pending })),
    http.post("/api/leave-requests/:id/:action", async ({ params, request }) => {
      const action = String(params.action);
      const body = (await request.json()) as { note?: string };
      bodies.push({ action, body });
      current = decided(initial, action === "approve" ? "APPROVED" : "REJECTED", body.note ?? null);
      pending = [];
      return HttpResponse.json({ leaveRequest: current });
    }),
  );
  return { bodies };
}

function mockActionError(action: "approve" | "reject", status: number, error: string, code?: string) {
  server.use(
    http.post(`/api/leave-requests/:id/${action}`, () => HttpResponse.json(code ? { error, code } : { error }, { status })),
  );
}

function menuLink() {
  const nav = screen.getByRole("navigation", { name: "Principal" });
  return within(nav).getByRole("link", { name: /^Aprobaciones/ });
}

describe("request detail texts depend on who views it", () => {
  it("the requester: own wording, back to Mis solicitudes, no decision buttons or balance", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockDetail(() => HttpResponse.json({ leaveRequest: buildDetail() }));
    renderApp("/solicitudes/req-1");

    await screen.findByRole("heading", { level: 2, name: "Vacaciones" });
    expect(field("Descuenta de tus vacaciones")).toBe("Sí");
    expect(screen.queryByText("Solicitante")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Mis solicitudes" })).toHaveAttribute("href", "/solicitudes");
    expect(screen.queryByRole("button", { name: "Aprobar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rechazar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Saldo de vacaciones de/ })).not.toBeInTheDocument();
  });

  it("the decider: requester's name, third-person wording, balance, buttons, back to Aprobaciones", async () => {
    mockSession(MANAGER);
    mockDetail(() => HttpResponse.json({ leaveRequest: buildDecidableDetail() }));
    renderApp("/solicitudes/req-1");

    await screen.findByRole("heading", { level: 2, name: "Vacaciones" });
    expect(field("Solicitante")).toBe("Ana García");
    expect(field("Descuenta de sus vacaciones")).toBe("Sí");
    expect(screen.queryByText("Descuenta de tus vacaciones")).not.toBeInTheDocument();
    // Opened directly (no router state): someone else's request still goes back to Aprobaciones.
    expect(screen.getByRole("link", { name: "Volver a Aprobaciones" })).toHaveAttribute("href", "/aprobaciones");

    const balance = screen.getByRole("region", { name: "Saldo de vacaciones de Ana García" });
    expect(balance).toHaveTextContent(/15 de marzo de 2026 al 14 de marzo de 2027/);
    expect(within(balance).getByText("Disponibles sin esta solicitud").nextElementSibling).toHaveTextContent("14 días");
    expect(within(balance).getByText("Si la apruebas, le quedan").nextElementSibling).toHaveTextContent("11 días");
    expect(screen.getByRole("button", { name: "Aprobar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancelar/ })).not.toBeInTheDocument();
  });

  it("HR viewing a request it cannot decide: no buttons and no balance", async () => {
    mockSession(buildUser("HR"));
    mockDetail(() =>
      HttpResponse.json({
        leaveRequest: buildDetail({ permissions: { canApprove: false, canReject: false, canCancel: false } }),
      }),
    );
    renderApp("/solicitudes/req-1");

    await screen.findByRole("heading", { level: 2, name: "Vacaciones" });
    expect(field("Descuenta de sus vacaciones")).toBe("Sí");
    expect(screen.queryByRole("button", { name: "Aprobar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Saldo de vacaciones de/ })).not.toBeInTheDocument();
  });

  it("warns when the period is already negative and does not offer Aprobar", async () => {
    mockSession(MANAGER);
    mockDetail(() =>
      HttpResponse.json({
        leaveRequest: buildDecidableDetail({
          requesterBalance: buildRequesterBalance({ availableWithoutRequest: 1, availableAfterApproval: -2, blocksApproval: true }),
        }),
      }),
    );
    renderApp("/solicitudes/req-1");

    const balance = await screen.findByRole("region", { name: "Saldo de vacaciones de Ana García" });
    // Real minus sign, as everywhere else in the UI.
    expect(balance).toHaveTextContent("−2 días");
    expect(within(balance).getByText("El saldo de este periodo ya es negativo")).toBeInTheDocument();
    // A warning present from the start is not a live alert (it would interrupt the screen reader).
    expect(within(balance).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprobar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeInTheDocument();
  });
});

describe("approve dialog", () => {
  it("approves without a note, then shows the updated detail and refreshes the counter", async () => {
    mockSession(MANAGER);
    const { bodies } = mockDecisionFlow(buildDecidableDetail());
    const { user } = renderApp("/solicitudes/req-1");

    await waitFor(() => expect(menuLink()).toHaveAccessibleName("Aprobaciones (1 pendiente)"));
    await user.click(await screen.findByRole("button", { name: "Aprobar" }));
    const dialog = await screen.findByRole("alertdialog", { name: "¿Aprobar esta solicitud?" });
    expect(dialog).toHaveTextContent("Le quedarán 11 días de vacaciones en este periodo.");
    expect(within(dialog).getByLabelText("Nota para el empleado (opcional)")).not.toBeRequired();
    await user.click(within(dialog).getByRole("button", { name: "Sí, aprobar" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([{ action: "approve", body: {} }]);
    expect(await screen.findByText("Aprobada", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Aprobaste la solicitud.");
    expect(screen.queryByRole("button", { name: "Aprobar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Saldo de vacaciones de/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Detalle de solicitud" })).toHaveFocus();
    await waitFor(() => expect(menuLink()).toHaveAccessibleName("Aprobaciones"));
  });

  it("sends the optional note, trimmed", async () => {
    mockSession(MANAGER);
    const { bodies } = mockDecisionFlow(buildDecidableDetail());
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Aprobar" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Nota para el empleado (opcional)"), "  Que descanses  ");
    await user.click(within(dialog).getByRole("button", { name: "Sí, aprobar" }));

    await waitFor(() => expect(bodies).toEqual([{ action: "approve", body: { note: "Que descanses" } }]));
  });

  it("warns before approving an overdue request", async () => {
    mockSession(MANAGER);
    mockDetail(() =>
      HttpResponse.json({ leaveRequest: buildDecidableDetail({ startDate: "2026-11-16", endDate: "2026-11-17", isOverdue: true }) }),
    );
    const { user } = renderApp("/solicitudes/req-1");

    // On the page, with text (not only color)...
    expect(await screen.findByText("Vencida: ya empezó y sigue pendiente")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Aprobar" }));
    // ...and again inside the dialog, before confirming.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Esta solicitud ya empezó");
    expect(dialog).toHaveTextContent("16 de noviembre de 2026");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a 409 inside the dialog, refreshes behind it, and only closes when asked", async () => {
    mockSession(MANAGER);
    let current = buildDecidableDetail();
    mockDetail(() => HttpResponse.json({ leaveRequest: current }));
    server.use(
      http.post("/api/leave-requests/:id/approve", () => {
        // The employee cancelled it meanwhile.
        current = buildDetail({
          status: "CANCELLED",
          permissions: { canApprove: false, canReject: false, canCancel: false },
        });
        return HttpResponse.json({ error: "No se puede aprobar una solicitud cancelada" }, { status: 409 });
      }),
    );
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Aprobar" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Sí, aprobar" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("La solicitud cambió de estado");
    // The detail behind refreshed (the trigger is gone) but the dialog is still readable.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Aprobar" })).not.toBeInTheDocument());
    expect(screen.getByRole("alertdialog")).toHaveTextContent("el empleado la canceló");
    // Retrying can never succeed: confirm is disabled and focus moved to "Volver", the only way out.
    expect(within(dialog).getByRole("button", { name: "Sí, aprobar" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Nota para el empleado (opcional)")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Volver" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByText("Cancelada", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Detalle de solicitud" })).toHaveFocus();
  });

  it("after a 409 on reject, only Volver is left and nothing else is sent", async () => {
    mockSession(MANAGER);
    mockDetail(() => HttpResponse.json({ leaveRequest: buildDecidableDetail() }));
    let calls = 0;
    server.use(
      http.post("/api/leave-requests/:id/reject", () => {
        calls++;
        return HttpResponse.json({ error: "No se puede rechazar una solicitud cancelada" }, { status: 409 });
      }),
    );
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Rechazar" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Motivo del rechazo (obligatorio)"), "Cierre de mes");
    await user.click(within(dialog).getByRole("button", { name: "Sí, rechazar" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("La solicitud cambió de estado");
    const confirm = within(dialog).getByRole("button", { name: "Sí, rechazar" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByLabelText("Motivo del rechazo (obligatorio)")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus();
    // Clicking the disabled button sends nothing again.
    await user.click(confirm);
    expect(calls).toBe(1);

    await user.click(within(dialog).getByRole("button", { name: "Volver" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("shows a 422 (insufficient balance) inside the dialog", async () => {
    mockSession(MANAGER);
    mockDetail(() => HttpResponse.json({ leaveRequest: buildDecidableDetail() }));
    mockActionError(
      "approve",
      422,
      "Saldo insuficiente para aprobar: el periodo 2026-03-15 a 2027-03-14 quedaría con -1 días",
      "INSUFFICIENT_BALANCE",
    );
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Aprobar" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Sí, aprobar" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Saldo insuficiente para aprobar");
    // Own text, not the API's ISO dates.
    expect(alert).not.toHaveTextContent("2026-03-15");
    expect(within(dialog).getByRole("button", { name: "Sí, aprobar" })).toBeEnabled();
  });
});

describe("reject dialog", () => {
  it("requires a note: an empty or blank one is not sent", async () => {
    mockSession(MANAGER);
    const { bodies } = mockDecisionFlow(buildDecidableDetail());
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Rechazar" }));
    const dialog = await screen.findByRole("alertdialog", { name: "¿Rechazar esta solicitud?" });
    const note = within(dialog).getByLabelText("Motivo del rechazo (obligatorio)");
    // Starts on the note, the one thing rejecting needs.
    await waitFor(() => expect(note).toHaveFocus());
    expect(note).toBeRequired();

    await user.click(within(dialog).getByRole("button", { name: "Sí, rechazar" }));
    expect(note).toHaveAttribute("aria-invalid", "true");
    expect(note).toHaveAccessibleDescription(/Escribe el motivo del rechazo/);
    expect(note).toHaveFocus();

    await user.type(note, "   ");
    await user.click(within(dialog).getByRole("button", { name: "Sí, rechazar" }));
    expect(note).toHaveAttribute("aria-invalid", "true");
    expect(bodies).toEqual([]);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("rejects with the note and shows it in the updated detail", async () => {
    mockSession(MANAGER);
    const { bodies } = mockDecisionFlow(buildDecidableDetail());
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Rechazar" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Los días apartados volverán a su saldo (quedaría con 14 días).");
    const note = within(dialog).getByLabelText("Motivo del rechazo (obligatorio)");
    await user.click(within(dialog).getByRole("button", { name: "Sí, rechazar" }));
    await user.type(note, "Cierre de mes");
    // Typing clears the error.
    expect(note).not.toHaveAttribute("aria-invalid");
    await user.click(within(dialog).getByRole("button", { name: "Sí, rechazar" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([{ action: "reject", body: { note: "Cierre de mes" } }]);
    expect(await screen.findByText("Rechazada", { selector: "span" })).toBeInTheDocument();
    expect(field("Rechazada por")).toContain("Luis Pérez");
    expect(field("Nota de la decisión")).toBe("Cierre de mes");
    expect(screen.getByRole("status")).toHaveTextContent("Rechazaste la solicitud.");
  });

  it("shows a 403 inside the dialog and refreshes the detail behind it (HR, who still sees it)", async () => {
    // HR decided as fallback; meanwhile the employee got an active manager.
    // HR can still view the request (any HR can), so the refresh is a 200.
    mockSession(buildUser("HR"));
    let current = buildDecidableDetail();
    mockDetail(() => HttpResponse.json({ leaveRequest: current }));
    server.use(
      http.post("/api/leave-requests/:id/reject", () => {
        current = buildDetail({ permissions: { canApprove: false, canReject: false, canCancel: false } });
        return HttpResponse.json({ error: "No te corresponde decidir esta solicitud" }, { status: 403 });
      }),
    );
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Rechazar" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Motivo del rechazo (obligatorio)"), "No hay cobertura");
    await user.click(within(dialog).getByRole("button", { name: "Sí, rechazar" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("No puedes decidir esta solicitud");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Rechazar" })).not.toBeInTheDocument());
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    // What was typed is still there (nothing reset the form).
    expect(within(dialog).getByLabelText("Motivo del rechazo (obligatorio)")).toHaveValue("No hay cobertura");
  });
});

describe("decision dialogs keep their error when the refresh fails", () => {
  it("POST 404 + GET 404 (the employee changed manager): the dialog stays, then focus goes to the h1", async () => {
    mockSession(MANAGER);
    let lostAccess = false;
    mockDetail(() =>
      lostAccess
        ? HttpResponse.json({ error: "Solicitud no encontrada" }, { status: 404 })
        : HttpResponse.json({ leaveRequest: buildDecidableDetail() }),
    );
    server.use(
      http.post("/api/leave-requests/:id/approve", () => {
        lostAccess = true;
        return HttpResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
      }),
    );
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Aprobar" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Sí, aprobar" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("No encontramos esta solicitud");
    // The refresh behind failed with 404: the page keeps the last data, without actions...
    expect(await screen.findByText("Ya no tienes acceso a esta solicitud")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprobar" })).not.toBeInTheDocument();
    // ...and the dialog is still there with its error.
    expect(screen.getByRole("alertdialog")).toHaveTextContent("No encontramos esta solicitud");

    await user.click(within(dialog).getByRole("button", { name: "Volver" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "Detalle de solicitud" })).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2, name: "Vacaciones" })).toBeInTheDocument();
  });
});

describe("while a decision is being sent", () => {
  it("shows Aprobando…, blocks a second submit and Escape, and sends only one request", async () => {
    mockSession(MANAGER);
    const gate = deferred();
    let calls = 0;
    mockDetail(() => HttpResponse.json({ leaveRequest: buildDecidableDetail() }));
    server.use(
      http.post("/api/leave-requests/:id/approve", async () => {
        calls++;
        await gate.promise;
        return HttpResponse.json({ leaveRequest: decided(buildDecidableDetail(), "APPROVED", null) });
      }),
    );
    const { user } = renderApp("/solicitudes/req-1");

    await user.click(await screen.findByRole("button", { name: "Aprobar" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Sí, aprobar" }));

    const sending = await within(dialog).findByRole("button", { name: "Aprobando…" });
    expect(sending).toBeDisabled();
    expect(within(dialog).getByLabelText("Nota para el empleado (opcional)")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toBeDisabled();
    await user.click(sending);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(calls).toBe(1);

    gate.resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(calls).toBe(1);
    expect(await screen.findByText("Aprobada", { selector: "span" })).toBeInTheDocument();
  });
});
