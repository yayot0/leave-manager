import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { LeaveRequest } from "@/api/types";
import { queryKeys } from "@/api/query-keys";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildBalance, buildDetail, buildLeaveRequest, buildUser, PERSONAL_TYPE } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

function mockMine(requests: LeaveRequest[]) {
  server.use(http.get("/api/leave-requests/mine", () => HttpResponse.json({ leaveRequests: requests })));
}

/** The desktop table (the phone cards render the same data; jsdom has no CSS). */
async function findTable() {
  return screen.findByRole("table");
}

function rowOf(table: HTMLElement, text: string): HTMLElement {
  const row = within(table).getByText(text).closest("tr");
  if (!row) throw new Error(`No row with ${text}`);
  return row;
}

describe("MyRequestsPage", () => {
  it("shows a loading state while the list loads", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const gate = deferred();
    server.use(
      http.get("/api/leave-requests/mine", async () => {
        await gate.promise;
        return HttpResponse.json({ leaveRequests: [buildLeaveRequest()] });
      }),
    );
    renderApp("/solicitudes");

    expect(await screen.findByText("Cargando tus solicitudes…")).toBeInTheDocument();
    gate.resolve();
    expect(await findTable()).toBeInTheDocument();
  });

  it("shows a friendly empty state with a link to create one", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockMine([]);
    renderApp("/solicitudes");

    expect(await screen.findByRole("heading", { name: "Aún no tienes solicitudes" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Crear mi primera solicitud" })).toHaveAttribute(
      "href",
      "/solicitudes/nueva",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the error and recovers with Reintentar", async () => {
    mockSession(buildUser("EMPLOYEE"));
    server.use(http.get("/api/leave-requests/mine", () => HttpResponse.error()));
    const { user } = renderApp("/solicitudes");

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar tus solicitudes");
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo conectar con el servidor");

    mockMine([buildLeaveRequest()]);
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await findTable()).toBeInTheDocument();
  });

  it("lists dates, type, business days and status as text (not only color)", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockMine([
      buildLeaveRequest({ id: "r1", startDate: "2026-12-01", endDate: "2026-12-03", businessDays: 3, status: "PENDING" }),
      buildLeaveRequest({
        id: "r2",
        startDate: "2027-01-01",
        endDate: "2027-01-01",
        businessDays: 1,
        status: "REJECTED",
        leaveType: PERSONAL_TYPE,
        permissions: { canCancel: false },
      }),
    ]);
    renderApp("/solicitudes");

    const table = await findTable();
    // Date-only values stay on their day in Monterrey (no "30 nov" / "31 dic").
    const first = rowOf(table, "1 dic 2026 al 3 dic 2026");
    expect(within(first).getByText("Vacaciones")).toBeInTheDocument();
    expect(within(first).getByText("3")).toBeInTheDocument();
    expect(within(first).getByText("Pendiente")).toBeInTheDocument();

    const second = rowOf(table, "1 ene 2027");
    expect(within(second).getByText("Permiso personal")).toBeInTheDocument();
    expect(within(second).getByText("Rechazada")).toBeInTheDocument();

    // Phones get the same requests as cards.
    const cards = screen.getByRole("list", { name: "Solicitudes" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(2);
    expect(within(cards).getByText("1 día hábil")).toBeInTheDocument();
  });

  it("links each request to its detail, escaping the id", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockMine([buildLeaveRequest({ id: "a/b?c" })]);
    renderApp("/solicitudes");

    const table = await findTable();
    expect(within(table).getByRole("link", { name: /Ver detalle de Vacaciones/ })).toHaveAttribute(
      "href",
      "/solicitudes/a%2Fb%3Fc",
    );
  });

  it("offers Cancelar only where the API allows it", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockMine([
      buildLeaveRequest({ id: "r1", startDate: "2026-12-01", endDate: "2026-12-01", permissions: { canCancel: true } }),
      buildLeaveRequest({
        id: "r2",
        startDate: "2026-11-02",
        endDate: "2026-11-02",
        status: "APPROVED",
        permissions: { canCancel: false },
      }),
    ]);
    renderApp("/solicitudes");

    const table = await findTable();
    expect(within(rowOf(table, "1 dic 2026")).getByRole("button", { name: /Cancelar solicitud/ })).toBeInTheDocument();
    expect(within(rowOf(table, "2 nov 2026")).queryByRole("button", { name: /Cancelar/ })).not.toBeInTheDocument();
  });

  describe("cancel dialog", () => {
    it("closes with Volver without cancelling anything", async () => {
      mockSession(buildUser("EMPLOYEE"));
      mockMine([buildLeaveRequest()]);
      let cancelCalls = 0;
      server.use(
        http.post("/api/leave-requests/:id/cancel", () => {
          cancelCalls++;
          return HttpResponse.json({ leaveRequest: buildDetail() });
        }),
      );
      const { user } = renderApp("/solicitudes");

      const table = await findTable();
      const trigger = within(table).getByRole("button", { name: /Cancelar solicitud/ });
      await user.click(trigger);

      const dialog = await screen.findByRole("alertdialog", { name: "¿Cancelar esta solicitud?" });
      expect(dialog).toHaveTextContent("Vacaciones, 1 dic 2026 al 3 dic 2026 (3 días hábiles)");
      expect(dialog).toHaveTextContent("Los días que tenía apartados volverán a tu saldo.");

      await user.click(within(dialog).getByRole("button", { name: "Volver" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(cancelCalls).toBe(0);
      expect(trigger).toHaveFocus();
    });

    it("cancels with the escaped id and note, then refreshes the list and the balance", async () => {
      mockSession(buildUser("EMPLOYEE"));
      const id = "a/b";
      let current = [buildLeaveRequest({ id })];
      server.use(http.get("/api/leave-requests/mine", () => HttpResponse.json({ leaveRequests: current })));
      let cancelled: { path: string; body: unknown } | null = null;
      server.use(
        http.post("/api/leave-requests/:id/cancel", async ({ request }) => {
          cancelled = { path: new URL(request.url).pathname, body: await request.json() };
          current = [buildLeaveRequest({ id, status: "CANCELLED", permissions: { canCancel: false } })];
          return HttpResponse.json({ leaveRequest: buildDetail({ id, status: "CANCELLED" }) });
        }),
      );
      const { user, queryClient } = renderApp("/solicitudes");
      // The balance is cached from an earlier visit to "Mi saldo".
      queryClient.setQueryData(queryKeys.balance, buildBalance());

      const table = await findTable();
      await user.click(within(table).getByRole("button", { name: /Cancelar solicitud/ }));
      const dialog = await screen.findByRole("alertdialog");
      await user.type(within(dialog).getByLabelText("Motivo de la cancelación (opcional)"), "  Cambié de planes  ");
      await user.click(within(dialog).getByRole("button", { name: "Sí, cancelar solicitud" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(cancelled).toEqual({ path: "/api/leave-requests/a%2Fb/cancel", body: { note: "Cambié de planes" } });
      expect(await within(table).findByText("Cancelada")).toBeInTheDocument();
      expect(within(table).queryByRole("button", { name: /Cancelar solicitud/ })).not.toBeInTheDocument();
      expect(queryClient.getQueryState(queryKeys.balance)?.isInvalidated).toBe(true);
      // Its trigger is gone, so focus lands on the page heading, not on <body>.
      expect(screen.getByRole("heading", { level: 1, name: "Mis solicitudes" })).toHaveFocus();
    });

    it("disables the buttons while the cancellation is in flight", async () => {
      mockSession(buildUser("EMPLOYEE"));
      mockMine([buildLeaveRequest()]);
      const gate = deferred();
      server.use(
        http.post("/api/leave-requests/:id/cancel", async () => {
          await gate.promise;
          return HttpResponse.json({ leaveRequest: buildDetail({ status: "CANCELLED" }) });
        }),
      );
      const { user } = renderApp("/solicitudes");

      await user.click(within(await findTable()).getByRole("button", { name: /Cancelar solicitud/ }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, cancelar solicitud" }));

      expect(within(dialog).getByRole("button", { name: "Cancelando…" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Volver" })).toBeDisabled();
      gate.resolve();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("keeps a 409 readable in the dialog while the stale list refreshes behind it", async () => {
      mockSession(buildUser("EMPLOYEE"));
      let current = [buildLeaveRequest()];
      server.use(
        http.get("/api/leave-requests/mine", () => HttpResponse.json({ leaveRequests: current })),
        http.post("/api/leave-requests/:id/cancel", () => {
          // Meanwhile the manager rejected it.
          current = [buildLeaveRequest({ status: "REJECTED", permissions: { canCancel: false } })];
          return HttpResponse.json({ error: "La solicitud ya fue rechazada" }, { status: 409 });
        }),
      );
      const { user } = renderApp("/solicitudes");

      const table = await findTable();
      await user.click(within(table).getByRole("button", { name: /Cancelar solicitud/ }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, cancelar solicitud" }));

      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("La solicitud cambió de estado");
      // The list refreshes behind the dialog (its Cancelar button is gone)...
      expect(await within(table).findByText("Rechazada")).toBeInTheDocument();
      expect(within(table).queryByRole("button", { name: /Cancelar solicitud/ })).not.toBeInTheDocument();
      // ...and the dialog, with its error, is still there.
      expect(screen.getByRole("alertdialog")).toBe(dialog);
      expect(within(dialog).getByRole("alert")).toBe(alert);
      // Retrying can never succeed: confirm is disabled and focus moved to "Volver", the only way out.
      expect(within(dialog).getByRole("button", { name: "Sí, cancelar solicitud" })).toBeDisabled();
      expect(within(dialog).getByLabelText("Motivo de la cancelación (opcional)")).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus();

      await user.click(within(dialog).getByRole("button", { name: "Volver" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      // Its trigger is gone: focus goes to the heading, not to <body>.
      expect(screen.getByRole("heading", { level: 1, name: "Mis solicitudes" })).toHaveFocus();
    });

    it("explains a 404 (the request no longer exists) and refreshes the list", async () => {
      mockSession(buildUser("EMPLOYEE"));
      let current = [buildLeaveRequest()];
      server.use(
        http.get("/api/leave-requests/mine", () => HttpResponse.json({ leaveRequests: current })),
        http.post("/api/leave-requests/:id/cancel", () => {
          current = [];
          return HttpResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
        }),
      );
      const { user } = renderApp("/solicitudes");

      await user.click(within(await findTable()).getByRole("button", { name: /Cancelar solicitud/ }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, cancelar solicitud" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent("No encontramos esta solicitud");
      await user.click(within(dialog).getByRole("button", { name: "Volver" }));
      expect(await screen.findByRole("heading", { name: "Aún no tienes solicitudes" })).toBeInTheDocument();
    });
  });
});
