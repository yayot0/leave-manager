import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { LeaveRequestPreview } from "@/api/types";
import { queryKeys } from "@/api/query-keys";
import { PREVIEW_DEBOUNCE_MS } from "@/hooks/leave-requests";
import { renderApp } from "@/test/render";
import { mockDetail, mockSession, server } from "@/test/server";
import {
  buildBalance,
  buildDetail,
  buildLeaveRequest,
  buildPreview,
  buildUser,
  PERSONAL_TYPE,
  VACATION_TYPE,
} from "@/test/fixtures";
import { deferred } from "@/test/deferred";

type User = ReturnType<typeof renderApp>["user"];

async function fillForm(user: User, values: { type?: string; start?: string; end?: string; reason?: string }) {
  if (values.type) {
    await user.selectOptions(await screen.findByLabelText("Tipo de permiso"), values.type);
  }
  // Date inputs take the whole "YYYY-MM-DD" value at once (like the browser picker).
  if (values.start) fireEvent.change(screen.getByLabelText("Fecha de inicio"), { target: { value: values.start } });
  if (values.end) fireEvent.change(screen.getByLabelText("Fecha de fin"), { target: { value: values.end } });
  if (values.reason) await user.type(screen.getByLabelText("Motivo (opcional)"), values.reason);
}

function previewRegion() {
  return screen.getByRole("region", { name: "Vista previa" });
}

function mockPreview(preview: LeaveRequestPreview) {
  server.use(http.get("/api/leave-requests/preview", () => HttpResponse.json({ preview })));
}

async function waitForTypes() {
  await waitFor(() => expect(screen.getByLabelText("Tipo de permiso")).toBeEnabled());
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NewRequestPage", () => {
  describe("leave types", () => {
    it("disables the select while the types load, then lists them", async () => {
      mockSession(buildUser("EMPLOYEE"));
      const gate = deferred();
      server.use(
        http.get("/api/leave-types", async () => {
          await gate.promise;
          return HttpResponse.json({ leaveTypes: [VACATION_TYPE, PERSONAL_TYPE] });
        }),
      );
      renderApp("/solicitudes/nueva");

      const select = await screen.findByLabelText("Tipo de permiso");
      expect(select).toBeDisabled();
      expect(within(select).getByRole("option", { name: "Cargando tipos…" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enviar solicitud" })).toBeDisabled();

      gate.resolve();
      await waitForTypes();
      expect(within(select).getByRole("option", { name: "Vacaciones" })).toBeInTheDocument();
      expect(within(select).getByRole("option", { name: "Permiso personal" })).toBeInTheDocument();
    });

    it("explains when there are no leave types instead of showing an unusable form", async () => {
      mockSession(buildUser("EMPLOYEE"));
      server.use(http.get("/api/leave-types", () => HttpResponse.json({ leaveTypes: [] })));
      renderApp("/solicitudes/nueva");

      expect(await screen.findByRole("heading", { name: "No hay tipos de permiso disponibles" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Enviar solicitud" })).not.toBeInTheDocument();
    });

    it("shows an error with Reintentar when the types cannot be loaded", async () => {
      mockSession(buildUser("EMPLOYEE"));
      server.use(http.get("/api/leave-types", () => HttpResponse.error()));
      const { user } = renderApp("/solicitudes/nueva");

      expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar los tipos de permiso");
      server.use(http.get("/api/leave-types", () => HttpResponse.json({ leaveTypes: [VACATION_TYPE] })));
      await user.click(screen.getByRole("button", { name: "Reintentar" }));
      await waitForTypes();
    });
  });

  describe("preview", () => {
    it("asks to fill the fields first, without calling the API", async () => {
      mockSession(buildUser("EMPLOYEE"));
      let previewCalls = 0;
      server.use(
        http.get("/api/leave-requests/preview", () => {
          previewCalls++;
          return HttpResponse.json({ preview: buildPreview() });
        }),
      );
      renderApp("/solicitudes/nueva");
      await waitForTypes();

      // Only timers are faked (not promises), so React and MSW keep working.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.change(screen.getByLabelText("Tipo de permiso"), { target: { value: VACATION_TYPE.id } });
      fireEvent.change(screen.getByLabelText("Fecha de inicio"), { target: { value: "2026-12-01" } });
      // Well past the debounce: a request would have gone out by now.
      act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 3));

      expect(previewRegion()).toHaveTextContent("Elige el tipo y las fechas");
      expect(previewCalls).toBe(0);
    });

    it("waits for the user to stop typing and asks only once", async () => {
      mockSession(buildUser("EMPLOYEE"));
      const calls: string[] = [];
      server.use(
        http.get("/api/leave-requests/preview", ({ request }) => {
          calls.push(new URL(request.url).searchParams.get("endDate") ?? "");
          return HttpResponse.json({ preview: buildPreview() });
        }),
      );
      renderApp("/solicitudes/nueva");
      await waitForTypes();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.change(screen.getByLabelText("Tipo de permiso"), { target: { value: VACATION_TYPE.id } });
      fireEvent.change(screen.getByLabelText("Fecha de inicio"), { target: { value: "2026-12-01" } });
      for (const end of ["2026-12-02", "2026-12-03", "2026-12-04"]) {
        fireEvent.change(screen.getByLabelText("Fecha de fin"), { target: { value: end } });
        act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 100));
      }
      act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
      // Idle for a long while: renders must not keep restarting the timer or asking again.
      act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 10));
      vi.useRealTimers();

      await waitFor(() => expect(calls).toEqual(["2026-12-04"]));
      expect(await within(previewRegion()).findByText("Todo en orden", { exact: false })).toBeInTheDocument();
    });

    it("shows business days and the balance the server calculates, sending exactly the three fields", async () => {
      mockSession(buildUser("EMPLOYEE"));
      let params: Record<string, string> = {};
      server.use(
        http.get("/api/leave-requests/preview", ({ request }) => {
          params = Object.fromEntries(new URL(request.url).searchParams);
          return HttpResponse.json({
            preview: buildPreview({
              businessDays: 3,
              balance: { period: { start: "2026-03-01", end: "2027-02-28" }, available: 14, availableAfter: 11 },
            }),
          });
        }),
      );
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-01", end: "2026-12-03", reason: "Viaje" });

      const region = previewRegion();
      expect(await within(region).findByText("14 → 11")).toBeInTheDocument();
      expect(region).toHaveTextContent("Días hábiles3");
      // Period dates on their own day in Monterrey.
      expect(region).toHaveTextContent("del 1 de marzo de 2026 al 28 de febrero de 2027");
      expect(region).toHaveTextContent("Todo en orden");
      expect(params).toEqual({ leaveTypeId: VACATION_TYPE.id, startDate: "2026-12-01", endDate: "2026-12-03" });
    });

    it("says when the leave type does not count against vacations", async () => {
      mockSession(buildUser("EMPLOYEE"));
      mockPreview(buildPreview({ leaveType: PERSONAL_TYPE, balance: null }));
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Permiso personal", start: "2026-12-01", end: "2026-12-01" });

      expect(await within(previewRegion()).findByText("Permiso personal no descuenta de tus vacaciones.")).toBeInTheDocument();
    });

    it("shows the type's limit under the select, before asking for dates", async () => {
      mockSession(buildUser("EMPLOYEE"));
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();

      const select = screen.getByLabelText("Tipo de permiso");
      // Vacaciones has no limit: no hint.
      await user.selectOptions(select, "Vacaciones");
      expect(screen.queryByText(/por solicitud\./)).not.toBeInTheDocument();

      await user.selectOptions(select, "Permiso personal");
      expect(screen.getByText("Máximo 1 día hábil por solicitud.")).toBeInTheDocument();
      expect(select).toHaveAccessibleDescription("Máximo 1 día hábil por solicitud.");
    });

    it("shows EXCEEDS_TYPE_LIMIT from the preview, and the POST's 400 if sent anyway", async () => {
      mockSession(buildUser("EMPLOYEE"));
      mockPreview(
        buildPreview({
          businessDays: 3,
          leaveType: PERSONAL_TYPE,
          balance: null,
          canSubmit: false,
          problems: [
            { code: "EXCEEDS_TYPE_LIMIT", message: "Permiso personal permite máximo 1 día hábil por solicitud; esta tiene 3" },
          ],
        }),
      );
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Permiso personal", start: "2026-12-01", end: "2026-12-03" });

      const region = previewRegion();
      expect(await within(region).findByText(/permite máximo 1 día hábil por solicitud; esta tiene 3/)).toBeInTheDocument();

      // The API decides: sending anyway gets the same problem as a 400 with its code.
      server.use(
        http.post("/api/leave-requests", () =>
          HttpResponse.json(
            { error: "Permiso personal permite máximo 1 día hábil por solicitud; esta tiene 3", code: "EXCEEDS_TYPE_LIMIT" },
            { status: 400 },
          ),
        ),
      );
      await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("esta tiene 3");
      // It is about the range, not the type: the dates are marked, the type is not.
      expect(screen.getByLabelText("Fecha de inicio")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText("Tipo de permiso")).not.toHaveAttribute("aria-invalid");
    });

    it("lists every problem the server finds, with the resulting balance", async () => {
      mockSession(buildUser("EMPLOYEE"));
      mockPreview(
        buildPreview({
          businessDays: 17,
          balance: { period: { start: "2026-03-15", end: "2027-03-14" }, available: 14, availableAfter: -3 },
          canSubmit: false,
          problems: [
            { code: "OVERLAP", message: "Ya tienes una solicitud pendiente o aprobada que se encima con esas fechas (2026-12-02 a 2026-12-02)" },
            { code: "INSUFFICIENT_BALANCE", message: "Saldo insuficiente: solicitas 17 días hábiles y tienes 14 disponibles" },
          ],
        }),
      );
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-01", end: "2026-12-23" });

      const region = previewRegion();
      expect(await within(region).findByText("14 → −3")).toBeInTheDocument();
      expect(region).toHaveTextContent("Te faltarían 3 días: tienes 14 días disponibles");
      const problems = within(region).getAllByRole("listitem");
      expect(problems.map((item) => item.textContent)).toEqual([
        expect.stringContaining("se encima"),
        expect.stringContaining("Saldo insuficiente"),
      ]);
    });

    it("shows the validation details of a 400 (malformed range)", async () => {
      mockSession(buildUser("EMPLOYEE"));
      server.use(
        http.get("/api/leave-requests/preview", () =>
          HttpResponse.json(
            {
              error: "Datos de entrada inválidos",
              details: ["La fecha de fin no puede ser anterior a la fecha de inicio"],
            },
            { status: 400 },
          ),
        ),
      );
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-05", end: "2026-12-01" });

      expect(
        await within(previewRegion()).findByText("La fecha de fin no puede ser anterior a la fecha de inicio"),
      ).toBeInTheDocument();
    });
  });

  describe("submit", () => {
    it("creates the request, refreshes cached data and opens its detail", async () => {
      mockSession(buildUser("EMPLOYEE"));
      let body: unknown = null;
      server.use(
        http.post("/api/leave-requests", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ leaveRequest: buildLeaveRequest({ id: "nueva/1" }) }, { status: 201 });
        }),
      );
      mockDetail((id) => HttpResponse.json({ leaveRequest: buildDetail({ id }) }));
      const { user, router, queryClient } = renderApp("/solicitudes/nueva");
      queryClient.setQueryData(queryKeys.balance, buildBalance());
      queryClient.setQueryData(queryKeys.myLeaveRequests, []);
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-01", end: "2026-12-03", reason: "  Viaje familiar " });

      await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

      expect(await screen.findByRole("heading", { level: 1, name: "Detalle de solicitud" })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/solicitudes/nueva%2F1");
      expect(body).toEqual({
        leaveTypeId: VACATION_TYPE.id,
        startDate: "2026-12-01",
        endDate: "2026-12-03",
        reason: "Viaje familiar",
      });
      expect(queryClient.getQueryState(queryKeys.balance)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(queryKeys.myLeaveRequests)?.isInvalidated).toBe(true);
    });

    it("does not recompute the preview of the request it just sent", async () => {
      mockSession(buildUser("EMPLOYEE"));
      let previewCalls = 0;
      server.use(
        http.get("/api/leave-requests/preview", () => {
          previewCalls++;
          return HttpResponse.json({ preview: buildPreview() });
        }),
        http.post("/api/leave-requests", () => HttpResponse.json({ leaveRequest: buildLeaveRequest() }, { status: 201 })),
      );
      const gate = deferred();
      mockDetail(async () => {
        await gate.promise;
        return HttpResponse.json({ leaveRequest: buildDetail() });
      });
      const { user, router } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-01", end: "2026-12-03" });
      await within(previewRegion()).findByText("Todo en orden", { exact: false });
      expect(previewCalls).toBe(1);

      await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

      // Navigates right away (without waiting for refetches), and the
      // preview is not asked again (it would now "overlap" the new request).
      await waitFor(() => expect(router.state.location.pathname).toBe("/solicitudes/req-1"));
      expect(await screen.findByText("Cargando la solicitud…")).toBeInTheDocument();
      expect(previewCalls).toBe(1);
      gate.resolve();
      await screen.findByRole("heading", { level: 2, name: "Vacaciones" });
      expect(previewCalls).toBe(1);
    });

    it("marks the leave type, not the dates, when the API says the type is invalid", async () => {
      mockSession(buildUser("EMPLOYEE"));
      server.use(
        http.post("/api/leave-requests", () =>
          HttpResponse.json(
            { error: "Tipo de permiso no válido o inactivo", code: "INVALID_LEAVE_TYPE" },
            { status: 400 },
          ),
        ),
      );
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-01", end: "2026-12-03" });
      await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

      await screen.findByRole("alert");
      expect(screen.getByLabelText("Tipo de permiso")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText("Fecha de inicio")).not.toHaveAttribute("aria-invalid");
    });

    it("omits an empty reason and shows 'Enviando…' while in flight", async () => {
      mockSession(buildUser("EMPLOYEE"));
      const gate = deferred();
      let body: unknown = null;
      server.use(
        http.post("/api/leave-requests", async ({ request }) => {
          body = await request.json();
          await gate.promise;
          return HttpResponse.json({ leaveRequest: buildLeaveRequest() }, { status: 201 });
        }),
      );
      mockDetail(() => HttpResponse.json({ leaveRequest: buildDetail() }));
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-01", end: "2026-12-01", reason: "   " });
      await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

      expect(await screen.findByRole("button", { name: "Enviando…" })).toBeDisabled();
      gate.resolve();
      await screen.findByRole("heading", { level: 1, name: "Detalle de solicitud" });
      expect(body).toEqual({ leaveTypeId: VACATION_TYPE.id, startDate: "2026-12-01", endDate: "2026-12-01" });
    });

    it.each([
      {
        status: 400,
        code: "START_IN_PAST",
        error: "La fecha de inicio no puede ser anterior a hoy",
        title: "Revisa los datos de la solicitud",
      },
      {
        status: 400,
        code: "NO_BUSINESS_DAYS",
        error: "El rango no incluye días hábiles (solo fines de semana o festivos)",
        title: "Revisa los datos de la solicitud",
      },
      {
        status: 409,
        code: "OVERLAP",
        error: "Ya tienes una solicitud pendiente o aprobada que se encima con esas fechas (2026-12-02 a 2026-12-02)",
        title: "Las fechas se enciman con otra solicitud",
      },
      {
        status: 422,
        code: "INSUFFICIENT_BALANCE",
        error: "Saldo insuficiente: solicitas 3 días hábiles y tienes 1 disponibles en el periodo 2026-03-15 a 2027-03-14",
        title: "No te alcanzan los días",
      },
    ])("explains a $status ($code)", async ({ status, code, error, title }) => {
      mockSession(buildUser("EMPLOYEE"));
      server.use(http.post("/api/leave-requests", () => HttpResponse.json({ error, code }, { status })));
      const { user, router } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-01", end: "2026-12-03" });
      await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(title);
      expect(alert).toHaveTextContent(error);
      expect(router.state.location.pathname).toBe("/solicitudes/nueva");
      // The date fields point to the error, so a screen reader repeats it.
      const start = screen.getByLabelText("Fecha de inicio");
      expect(start).toHaveAttribute("aria-invalid", "true");
      expect(start).toHaveAccessibleDescription(expect.stringContaining(error));
    });

    it("lists the validation details of a 400 and clears the error when a field changes", async () => {
      mockSession(buildUser("EMPLOYEE"));
      server.use(
        http.post("/api/leave-requests", () =>
          HttpResponse.json(
            { error: "Datos de entrada inválidos", details: ["El rango no puede exceder 366 días"] },
            { status: 400 },
          ),
        ),
      );
      const { user } = renderApp("/solicitudes/nueva");
      await waitForTypes();
      await fillForm(user, { type: "Vacaciones", start: "2026-12-01", end: "2027-12-31" });
      await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

      const alert = await screen.findByRole("alert");
      expect(within(alert).getByRole("listitem")).toHaveTextContent("El rango no puede exceder 366 días");

      fireEvent.change(screen.getByLabelText("Fecha de fin"), { target: { value: "2026-12-05" } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Fecha de inicio")).not.toHaveAttribute("aria-invalid");
    });
  });
});
