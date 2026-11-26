import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { DeactivationImpact, DeactivationRequest, EmployeeDetail } from "@/api/types";
import { renderApp } from "@/test/render";
import { mockDetail, mockEmployeeDetail, mockSession, server } from "@/test/server";
import {
  buildBalance,
  buildDeactivationImpact,
  buildDetail,
  buildEmployee,
  buildEmployeeDetail,
  buildUser,
} from "@/test/fixtures";
import { deferred } from "@/test/deferred";

const DETAIL = "/administracion/empleados/emp-1";
const TEMP_PASSWORD = "nube-tortuga-faro-mango-27";
const NAME = "Laura Méndez Ortiz";

/** The current detail; tests mutate `state.current` to simulate a change on the server. */
function mockEmployee(employee: EmployeeDetail = buildEmployeeDetail()) {
  const state = { current: employee };
  const asked = mockEmployeeDetail(() => HttpResponse.json({ employee: state.current }));
  return { state, asked };
}

async function heading() {
  return screen.findByRole("heading", { level: 1, name: NAME });
}

/** Everything the TanStack caches hold, as text: a secret must never be there. */
function cachesAsText(queryClient: ReturnType<typeof renderApp>["queryClient"]): string {
  const queries = queryClient.getQueryCache().getAll().map((query) => query.state);
  const mutations = queryClient.getMutationCache().getAll().map((mutation) => mutation.state);
  return JSON.stringify({ queries, mutations });
}

const OVERDUE: DeactivationRequest = {
  id: "req/9",
  startDate: "2026-11-02",
  endDate: "2026-11-04",
  businessDays: 3,
  status: "PENDING",
  leaveType: { name: "Vacaciones" },
};

describe("EmployeeDetailPage", () => {
  describe("data", () => {
    it("shows the data, the manager (with a link), the direct reports and the balance", async () => {
      mockSession(buildUser("HR"));
      mockEmployee(
        buildEmployeeDetail({
          directReports: [
            { id: "emp-7", firstName: "Iván", lastName: "Soto", role: "EMPLOYEE", isActive: true },
            { id: "emp-8", firstName: "Rosa", lastName: "León", role: "EMPLOYEE", isActive: false },
          ],
          balance: buildBalance({ available: -2, yearsOfService: 1, earned: 12, approved: 10, pending: 4 }),
        }),
      );
      renderApp(DETAIL);
      await heading();

      const data = screen.getByRole("heading", { level: 2, name: "Datos" }).closest("[data-slot=card]") as HTMLElement;
      expect(data).toHaveTextContent("laura.mendez@empresa.com");
      expect(data).toHaveTextContent("Empleado");
      expect(data).toHaveTextContent("Tecnología");
      // A date-only value: no shift to 9 January in Monterrey.
      expect(data).toHaveTextContent("10 de enero de 2022");
      expect(within(data).getByRole("link", { name: "Ricardo Montemayor" })).toHaveAttribute(
        "href",
        "/administracion/empleados/mgr-1",
      );
      expect(data).toHaveTextContent("Jefe de área");

      const balance = screen.getByRole("heading", { level: 2, name: "Saldo de vacaciones" }).closest("[data-slot=card]");
      // Negative with the real minus sign; singular "año".
      expect(balance).toHaveTextContent("−2 días disponibles");
      expect(balance).toHaveTextContent("1 año de antigüedad");
      expect(balance).toHaveTextContent("12 días ganados · 10 días aprobados · 4 días pendientes");
      expect(balance).toHaveTextContent("15 de marzo de 2026 al 14 de marzo de 2027");

      const reports = screen.getByRole("heading", { level: 2, name: "Personas a su cargo" }).closest("[data-slot=card]") as HTMLElement;
      const items = within(reports).getAllByRole("listitem");
      expect(within(items[0]).getByRole("link", { name: "Iván Soto" })).toHaveAttribute("href", "/administracion/empleados/emp-7");
      expect(items[0]).not.toHaveTextContent("Dado de baja");
      expect(items[1]).toHaveTextContent("Dado de baja");
    });

    it("explains when there is no manager, nobody reports to them, and the temporary password badge", async () => {
      mockSession(buildUser("HR"));
      mockEmployee(buildEmployeeDetail({ manager: null, managerId: null, mustChangePassword: true }));
      renderApp(DETAIL);
      await heading();

      expect(screen.getByText("Sin jefe (decide RH)")).toBeInTheDocument();
      expect(screen.getByText("Nadie le reporta directamente.")).toBeInTheDocument();
      expect(screen.getByText("Con contraseña temporal")).toBeInTheDocument();
    });

    it("does not show the temporary password badge for an inactive employee", async () => {
      mockSession(buildUser("HR"));
      mockEmployee(buildEmployeeDetail({ isActive: false, mustChangePassword: true }));
      renderApp(DETAIL);
      await heading();

      expect(screen.getByText("Dado de baja")).toBeInTheDocument();
      expect(screen.queryByText("Con contraseña temporal")).not.toBeInTheDocument();
    });

    it("escapes the id when asking the API", async () => {
      mockSession(buildUser("HR"));
      const { asked } = mockEmployee(buildEmployeeDetail({ id: "a b/c" }));
      renderApp("/administracion/empleados/a%20b%2Fc");
      await heading();
      expect(asked).toEqual(["a b/c"]);
    });

    it("shows a not-found card for a 404 and an error with Reintentar for anything else", async () => {
      mockSession(buildUser("HR"));
      mockEmployeeDetail(() => HttpResponse.json({ error: "Empleado no encontrado" }, { status: 404 }));
      const first = renderApp("/administracion/empleados/nadie");
      expect(await screen.findByText(/Este empleado no existe/)).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Detalle de empleado" })).toBeInTheDocument();
      first.unmount();

      mockEmployeeDetail(() => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 }));
      const { user } = renderApp(DETAIL);
      expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar al empleado");
      mockEmployee();
      await user.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(await heading()).toBeInTheDocument();
    });

    it("keeps the data but offers no action when a refresh fails", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      const { queryClient } = renderApp(DETAIL);
      await heading();
      expect(screen.getByRole("button", { name: "Editar datos" })).toBeInTheDocument();

      mockEmployeeDetail(() => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 }));
      await queryClient.invalidateQueries({ queryKey: ["hr", "employees"] });

      expect(await screen.findByText("Estos datos pueden estar desactualizados")).toBeInTheDocument();
      expect(screen.getByText(NAME, { selector: "h1" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Editar datos" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Restablecer contraseña" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Dar de baja" })).not.toBeInTheDocument();
    });
  });

  describe("buttons follow `permissions` from the API", () => {
    it("active employee: edit, reset and deactivate (no reactivate)", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      renderApp(DETAIL);
      await heading();

      for (const name of ["Editar datos", "Restablecer contraseña", "Dar de baja"]) {
        expect(screen.getByRole("button", { name })).toHaveAttribute("aria-haspopup", "dialog");
      }
      expect(screen.queryByRole("button", { name: "Reactivar" })).not.toBeInTheDocument();
    });

    it("HR looking at themselves: only edit (no reset, deactivate or reactivate)", async () => {
      mockSession(buildUser("HR", { id: "emp-1" }));
      mockEmployee(
        buildEmployeeDetail({
          role: "HR",
          permissions: {
            canEditRole: false,
            canEditHireDate: false,
            canEditManager: false,
            canDeactivate: false,
            canReactivate: false,
            canResetPassword: false,
          },
        }),
      );
      renderApp(DETAIL);
      await heading();

      expect(screen.getByRole("button", { name: "Editar datos" })).toBeInTheDocument();
      for (const name of ["Restablecer contraseña", "Dar de baja", "Reactivar"]) {
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      }
    });

    it("inactive employee: edit and reactivate only", async () => {
      mockSession(buildUser("HR"));
      mockEmployee(
        buildEmployeeDetail({
          isActive: false,
          permissions: {
            canEditRole: true,
            canEditHireDate: true,
            canEditManager: true,
            canDeactivate: false,
            canReactivate: true,
            canResetPassword: false,
          },
        }),
      );
      renderApp(DETAIL);
      await heading();

      expect(screen.getByRole("button", { name: "Reactivar" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Dar de baja" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Restablecer contraseña" })).not.toBeInTheDocument();
    });
  });

  describe("reset password", () => {
    function mockReset(respond: () => Response | Promise<Response> = () => HttpResponse.json({
      temporaryPassword: TEMP_PASSWORD,
      user: { id: "emp-1", firstName: "Laura", lastName: "Méndez Ortiz", email: "laura.mendez@empresa.com" },
    })) {
      const calls: string[] = [];
      server.use(
        http.post("/api/hr/employees/:id/reset-password", ({ params }) => {
          calls.push(String(params.id));
          return respond();
        }),
      );
      return calls;
    }

    it("EMPLOYEE: normal warning, no checkbox; shows the password ONCE in the same dialog, focused, with Copiar", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      const calls = mockReset();
      const { user, queryClient } = renderApp(DETAIL);
      await heading();
      const writeText = vi.spyOn(navigator.clipboard, "writeText");

      await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
      const dialog = await screen.findByRole("dialog", { name: `¿Restablecer la contraseña de ${NAME}?` });
      expect(dialog).toHaveTextContent("se cerrarán todas sus sesiones");
      expect(within(dialog).getByText("Verás la contraseña temporal")).toBeInTheDocument();
      expect(within(dialog).getByText("Entrégala solo a Laura, en persona o por un canal privado.")).toBeInTheDocument();
      expect(within(dialog).queryByText(/Cuidado/)).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
      // A fixed warning, not an interrupting alert.
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Sí, restablecer" }));

      const password = await within(dialog).findByLabelText("Contraseña temporal");
      expect(calls).toEqual(["emp-1"]);
      expect(within(dialog).getByRole("heading", { name: `Contraseña temporal de ${NAME}` })).toBeInTheDocument();
      expect(password).toHaveValue(TEMP_PASSWORD);
      expect(password).toHaveAttribute("readonly");
      await waitFor(() => expect(password).toHaveFocus());
      expect(password).toHaveAccessibleDescription(/No se volverá a mostrar/);
      expect(within(dialog).getByText("No se volverá a mostrar")).toBeInTheDocument();
      expect(screen.getByText(`Contraseña de ${NAME} restablecida; sus sesiones se cerraron.`)).toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Copiar" }));
      expect(writeText).toHaveBeenCalledWith(TEMP_PASSWORD);
      const copyStatus = within(dialog).getAllByRole("status").find((element) => element.textContent?.includes("copiada"));
      expect(copyStatus).toHaveTextContent("Contraseña copiada.");

      // Not kept by TanStack Query (gcTime 0 + reset()).
      await waitFor(() => expect(cachesAsText(queryClient)).not.toContain(TEMP_PASSWORD));

      await user.click(within(dialog).getByRole("button", { name: "Listo, ya la copié" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.queryByDisplayValue(TEMP_PASSWORD)).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(TEMP_PASSWORD);
      expect(screen.getByRole("button", { name: "Restablecer contraseña" })).toHaveFocus();

      // Opening again starts with the confirmation: the password is gone for good.
      await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
      const again = await screen.findByRole("dialog", { name: `¿Restablecer la contraseña de ${NAME}?` });
      expect(within(again).queryByLabelText("Contraseña temporal")).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(TEMP_PASSWORD);
      expect(calls).toEqual(["emp-1"]);
    });

    it("explains when copying fails and the password must be copied by hand", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      mockReset();
      const { user } = renderApp(DETAIL);
      await heading();
      vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));

      await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, restablecer" }));
      await user.click(await within(dialog).findByRole("button", { name: "Copiar" }));

      expect(await within(dialog).findByText(/No se pudo copiar automáticamente/)).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Contraseña temporal")).toHaveValue(TEMP_PASSWORD);
    });

    it("cannot be dismissed with a click outside once the password is shown", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      mockReset();
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, restablecer" }));
      await within(dialog).findByLabelText("Contraseña temporal");

      const backdrop = document.querySelector("[data-slot=dialog-overlay]");
      expect(backdrop).not.toBeNull();
      await user.click(backdrop as Element);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Contraseña temporal")).toHaveValue(TEMP_PASSWORD);
    });

    it.each([
      ["MANAGER", "Jefe de área", "aprobar o rechazar solicitudes de su equipo"],
      ["HR", "Recursos Humanos", "administrar empleados y saldos"],
    ] as const)(
      "%s: stronger warning and a mandatory checkbox before 'Sí, restablecer'",
      async (role, roleLabel, power) => {
        mockSession(buildUser("HR"));
        mockEmployee(buildEmployeeDetail({ role }));
        const calls = mockReset();
        const { user } = renderApp(DETAIL);
        await heading();

        await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText(`Cuidado: es una cuenta de ${roleLabel}`)).toBeInTheDocument();
        expect(dialog).toHaveTextContent("todo quedaría registrado a su nombre, no al tuyo");
        expect(dialog).toHaveTextContent(power);

        const checkbox = within(dialog).getByRole("checkbox", { name: new RegExp(`podría ${power} en nombre de Laura`) });
        const confirm = within(dialog).getByRole("button", { name: "Sí, restablecer" });
        expect(checkbox).not.toBeChecked();
        expect(confirm).toBeDisabled();
        await user.click(confirm);
        expect(calls).toEqual([]);

        await user.click(checkbox);
        expect(confirm).toBeEnabled();
        await user.click(checkbox);
        expect(confirm).toBeDisabled();
        await user.click(checkbox);

        await user.click(confirm);
        expect(await within(dialog).findByLabelText("Contraseña temporal")).toHaveValue(TEMP_PASSWORD);
        expect(calls).toEqual(["emp-1"]);
      },
    );

    it("shows 'Restableciendo…' and cannot close while sending", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      const gate = deferred();
      mockReset(async () => {
        await gate.promise;
        return HttpResponse.json({
          temporaryPassword: TEMP_PASSWORD,
          user: { id: "emp-1", firstName: "Laura", lastName: "Méndez Ortiz", email: "x@empresa.com" },
        });
      });
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, restablecer" }));

      expect(await within(dialog).findByRole("button", { name: "Restableciendo…" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Volver" })).toBeDisabled();
      await user.keyboard("{Escape}");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      gate.resolve();
      expect(await within(dialog).findByLabelText("Contraseña temporal")).toHaveValue(TEMP_PASSWORD);
    });

    it("409 EMPLOYEE_INACTIVE: explains it, leaves only Volver and focuses it", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      mockReset(() =>
        HttpResponse.json({ error: "El empleado está dado de baja", code: "EMPLOYEE_INACTIVE" }, { status: 409 }),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, restablecer" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent("El empleado está dado de baja");
      expect(within(dialog).queryByRole("button", { name: "Sí, restablecer" })).not.toBeInTheDocument();
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus());
    });

    // BUG: the reset/reactivate mutations live in DetailContent (not inside
    // the keyed dialog), so their error survives closing the dialog. Opening
    // it again shows the OLD error, and after a 404/409 the confirm button
    // never comes back until the page is reloaded (CLAUDE.md: "formulario y
    // mutación nuevos en cada apertura").
    it("a new opening starts clean: the error of the previous one is not shown again", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      mockReset(() => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 }));
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, restablecer" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Error interno del servidor");
      await user.click(within(dialog).getByRole("button", { name: "Volver" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Restablecer contraseña" }));
      const again = await screen.findByRole("dialog");
      expect(within(again).queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("reactivate", () => {
    const INACTIVE = buildEmployeeDetail({
      isActive: false,
      updatedAt: "2026-11-05T10:00:00.000Z",
      permissions: {
        canEditRole: true,
        canEditHireDate: true,
        canEditManager: true,
        canDeactivate: false,
        canReactivate: true,
        canResetPassword: false,
      },
    });

    it("sends expectedUpdatedAt and shows the new temporary password once, in the same dialog", async () => {
      mockSession(buildUser("HR"));
      const { state } = mockEmployee(INACTIVE);
      const bodies: unknown[] = [];
      server.use(
        http.post("/api/hr/employees/:id/reactivate", async ({ request }) => {
          bodies.push(await request.json());
          state.current = { ...INACTIVE, isActive: true, mustChangePassword: true };
          return HttpResponse.json({ temporaryPassword: TEMP_PASSWORD, employee: buildEmployee({ isActive: true }) });
        }),
      );
      const { user, queryClient } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Reactivar" }));
      const dialog = await screen.findByRole("dialog", { name: `¿Reactivar a ${NAME}?` });
      expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Sí, reactivar" }));

      const password = await within(dialog).findByLabelText("Contraseña temporal");
      expect(bodies).toEqual([{ expectedUpdatedAt: "2026-11-05T10:00:00.000Z" }]);
      expect(within(dialog).getByRole("heading", { name: `${NAME} está activo de nuevo` })).toBeInTheDocument();
      expect(password).toHaveValue(TEMP_PASSWORD);
      await waitFor(() => expect(password).toHaveFocus());
      expect(within(dialog).getByText("No se volverá a mostrar")).toBeInTheDocument();
      expect(screen.getByText(`${NAME} fue reactivado.`)).toBeInTheDocument();
      // The detail refreshed behind the dialog, which must stay with the password.
      await waitFor(() => expect(screen.getByText("Con contraseña temporal")).toBeInTheDocument());
      expect(within(dialog).getByLabelText("Contraseña temporal")).toHaveValue(TEMP_PASSWORD);
      await waitFor(() => expect(cachesAsText(queryClient)).not.toContain(TEMP_PASSWORD));

      await user.click(within(dialog).getByRole("button", { name: "Listo, ya la copié" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(document.body).not.toHaveTextContent(TEMP_PASSWORD);
    });

    it("MANAGER: the same mandatory checkbox before reactivating", async () => {
      mockSession(buildUser("HR"));
      mockEmployee({ ...INACTIVE, role: "MANAGER" });
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Reactivar" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("button", { name: "Sí, reactivar" })).toBeDisabled();
      await user.click(within(dialog).getByRole("checkbox", { name: /aprobar o rechazar solicitudes/ }));
      expect(within(dialog).getByRole("button", { name: "Sí, reactivar" })).toBeEnabled();
    });

    it("STALE_DATA: explains someone else changed it and leaves only Volver", async () => {
      mockSession(buildUser("HR"));
      mockEmployee(INACTIVE);
      server.use(
        http.post("/api/hr/employees/:id/reactivate", () =>
          HttpResponse.json({ error: "Alguien más lo cambió", code: "STALE_DATA" }, { status: 409 }),
        ),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Reactivar" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, reactivar" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Otra persona modificó a este empleado");
      expect(within(dialog).queryByRole("button", { name: "Sí, reactivar" })).not.toBeInTheDocument();
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus());
      expect(document.body).not.toHaveTextContent(TEMP_PASSWORD);
    });

    // BUG (same cause as the reset one): after the STALE_DATA the detail is
    // refreshed (new updatedAt) but the mutation keeps its 409, so opening
    // "Reactivar" again shows only "Volver": HR cannot retry with the fresh
    // data without reloading the page.
    it("after STALE_DATA, opening Reactivar again offers 'Sí, reactivar' with the fresh data", async () => {
      mockSession(buildUser("HR"));
      const { state } = mockEmployee(INACTIVE);
      let calls = 0;
      server.use(
        http.post("/api/hr/employees/:id/reactivate", () => {
          calls++;
          state.current = { ...INACTIVE, updatedAt: "2026-11-06T10:00:00.000Z" };
          return HttpResponse.json({ error: "Alguien más lo cambió", code: "STALE_DATA" }, { status: 409 });
        }),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Reactivar" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, reactivar" }));
      await within(dialog).findByRole("alert");
      await user.click(within(dialog).getByRole("button", { name: "Volver" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Reactivar" }));
      const again = await screen.findByRole("dialog");
      expect(calls).toBe(1);
      expect(within(again).getByRole("button", { name: "Sí, reactivar" })).toBeEnabled();
    });
  });

  describe("deactivate", () => {
    function mockImpact(impact = buildDeactivationImpact()) {
      let calls = 0;
      server.use(
        http.get("/api/hr/employees/:id/deactivation-impact", () => {
          calls++;
          return HttpResponse.json(impact);
        }),
      );
      return { calls: () => calls };
    }

    it("without blockers: says how many requests are cancelled, then deactivates with expectedUpdatedAt", async () => {
      mockSession(buildUser("HR"));
      const { state } = mockEmployee();
      mockImpact(buildDeactivationImpact({ toCancel: { pending: 1, approved: 2 }, startedApproved: 1 }));
      const bodies: unknown[] = [];
      server.use(
        http.post("/api/hr/employees/:id/deactivate", async ({ request }) => {
          bodies.push(await request.json());
          state.current = buildEmployeeDetail({
            isActive: false,
            permissions: { ...state.current.permissions, canDeactivate: false, canReactivate: true },
          });
          return HttpResponse.json({ employee: buildEmployee({ isActive: false }), cancelledRequests: 3 });
        }),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog", { name: `¿Dar de baja a ${NAME}?` });
      const region = within(dialog).getByRole("status");
      expect(await within(region).findByText("Se cancelarán 3 solicitudes")).toBeInTheDocument();
      expect(region).toHaveTextContent("1 pendiente y 2 aprobadas que aún no empiezan");
      expect(region).toHaveTextContent("1 solicitud aprobada que ya empezó no cambia");
      expect(region).toHaveTextContent("Perderá el acceso de inmediato.");
      const confirm = within(dialog).getByRole("button", { name: "Sí, dar de baja" });
      expect(confirm).toHaveAccessibleDescription(/Se cancelarán 3 solicitudes/);

      await user.click(confirm);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(bodies).toEqual([{ expectedUpdatedAt: "2026-11-01T15:00:00.000Z" }]);
      expect(screen.getByText(`${NAME} fue dado de baja. Se cancelaron 3 solicitudes.`)).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Reactivar" })).toBeInTheDocument();
    });

    // BUG: the dialog closes right after the POST, while "Dar de baja" is
    // still on the page, so finalFocus returns it; the refetch then removes
    // it (canDeactivate false) and focus falls to <body>. Same bug class as
    // "los diálogos viven fuera de las filas" in CLAUDE.md: the dialog should
    // call markRemoved()/onRemoved (focus to the h1) since its opener vanishes.
    it("after deactivating, focus does not fall to <body> when the 'Dar de baja' button disappears", async () => {
      mockSession(buildUser("HR"));
      const { state } = mockEmployee();
      mockImpact();
      server.use(
        http.post("/api/hr/employees/:id/deactivate", () => {
          state.current = buildEmployeeDetail({
            isActive: false,
            permissions: { ...state.current.permissions, canDeactivate: false, canReactivate: true },
          });
          return HttpResponse.json({ employee: buildEmployee({ isActive: false }), cancelledRequests: 0 });
        }),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(await within(dialog).findByRole("button", { name: "Sí, dar de baja" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      await screen.findByRole("button", { name: "Reactivar" });
      expect(screen.queryByRole("button", { name: "Dar de baja" })).not.toBeInTheDocument();
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    });

    it("after reactivating, focus does not fall to <body> when the 'Reactivar' button disappears", async () => {
      mockSession(buildUser("HR"));
      const inactive = buildEmployeeDetail({
        isActive: false,
        permissions: {
          canEditRole: true,
          canEditHireDate: true,
          canEditManager: true,
          canDeactivate: false,
          canReactivate: true,
          canResetPassword: false,
        },
      });
      const { state } = mockEmployee(inactive);
      server.use(
        http.post("/api/hr/employees/:id/reactivate", () => {
          state.current = buildEmployeeDetail();
          return HttpResponse.json({ temporaryPassword: TEMP_PASSWORD, employee: buildEmployee() });
        }),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Reactivar" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Sí, reactivar" }));
      await within(dialog).findByLabelText("Contraseña temporal");
      await waitFor(() => expect(screen.queryByText("Dado de baja", { selector: "span" })).not.toBeInTheDocument());
      await user.click(within(dialog).getByRole("button", { name: "Listo, ya la copié" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    });

    it("says nothing is cancelled when there is nothing to cancel", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      mockImpact();
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(await within(dialog).findByText("No se cancelará ninguna solicitud")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Sí, dar de baja" })).toBeEnabled();
    });

    it("cannot be confirmed while the impact loads, and asks it fresh on every opening", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      const gate = deferred();
      let calls = 0;
      server.use(
        http.get("/api/hr/employees/:id/deactivation-impact", async () => {
          calls++;
          await gate.promise;
          return HttpResponse.json(buildDeactivationImpact());
        }),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(await within(dialog).findByText("Revisando sus solicitudes y personas a cargo…")).toBeInTheDocument();
      // Not offered until a fresh preview says it can be done.
      expect(within(dialog).queryByRole("button", { name: "Sí, dar de baja" })).not.toBeInTheDocument();
      gate.resolve();
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Sí, dar de baja" })).toBeEnabled());

      await user.click(within(dialog).getByRole("button", { name: "Volver" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      await screen.findByRole("alertdialog");
      await waitFor(() => expect(calls).toBe(2));
    });

    it("explains when the impact cannot be checked and does not offer to confirm", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      server.use(
        http.get("/api/hr/employees/:id/deactivation-impact", () =>
          HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 }),
        ),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(await within(dialog).findByText(/No se pudo revisar qué pasará con sus solicitudes/)).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Sí, dar de baja" })).not.toBeInTheDocument();
    });

    it("HAS_ACTIVE_REPORTS: lists the active reports with links and offers only Volver", async () => {
      mockSession(buildUser("HR"));
      mockEmployee(buildEmployeeDetail({ role: "MANAGER" }));
      mockImpact(
        buildDeactivationImpact({
          blocker: "HAS_ACTIVE_REPORTS",
          activeReports: [
            { id: "emp-7", firstName: "Iván", lastName: "Soto" },
            { id: "emp 8", firstName: "Rosa", lastName: "León" },
          ],
        }),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(await within(dialog).findByText("Primero reasigna a las personas a su cargo")).toBeInTheDocument();
      expect(within(dialog).getByRole("link", { name: "Iván Soto" })).toHaveAttribute("href", "/administracion/empleados/emp-7");
      expect(within(dialog).getByRole("link", { name: "Rosa León" })).toHaveAttribute("href", "/administracion/empleados/emp%208");
      expect(within(dialog).queryByRole("button", { name: "Sí, dar de baja" })).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Volver" })).toBeInTheDocument();
    });

    it("LAST_ACTIVE_HR: explains at least one HR must remain", async () => {
      mockSession(buildUser("HR"));
      mockEmployee(buildEmployeeDetail({ role: "HR" }));
      mockImpact(buildDeactivationImpact({ blocker: "LAST_ACTIVE_HR", isLastActiveHr: true }));
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(await within(dialog).findByText("Es la única persona activa de RH")).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Sí, dar de baja" })).not.toBeInTheDocument();
    });

    it("HAS_OVERDUE_PENDING_REQUESTS: links each request; its 'Volver al empleado' comes back here", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      mockImpact(buildDeactivationImpact({ blocker: "HAS_OVERDUE_PENDING_REQUESTS", overdueRequests: [OVERDUE] }));
      mockDetail((id) =>
        HttpResponse.json({
          leaveRequest: buildDetail({
            id,
            startDate: OVERDUE.startDate,
            endDate: OVERDUE.endDate,
            isOverdue: true,
            requester: { id: "emp-1", firstName: "Laura", lastName: "Méndez Ortiz" },
            permissions: { canApprove: false, canReject: false, canCancel: false },
          }),
        }),
      );
      const { user, router } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(await within(dialog).findByText("Tiene solicitudes pendientes que ya empezaron")).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Sí, dar de baja" })).not.toBeInTheDocument();
      const link = within(dialog).getByRole("link", { name: "Vacaciones: 2 de noviembre de 2026 al 4 de noviembre de 2026" });
      expect(link).toHaveAttribute("href", "/solicitudes/req%2F9");
      expect(link.closest("li")).toHaveTextContent("(3 días hábiles)");

      await user.click(link);
      expect(await screen.findByRole("heading", { level: 1, name: "Detalle de solicitud" })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/solicitudes/req%2F9");
      const back = await screen.findByRole("link", { name: "Volver al empleado" });
      expect(back).toHaveAttribute("href", DETAIL);

      await user.click(back);
      expect(await heading()).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(DETAIL);
    });

    it("a 409 HAS_OVERDUE_PENDING_REQUESTS from the POST lists the requests it brings", async () => {
      mockSession(buildUser("HR"));
      mockEmployee();
      mockImpact();
      server.use(
        http.post("/api/hr/employees/:id/deactivate", () =>
          HttpResponse.json(
            {
              error: "Tiene solicitudes pendientes que ya empezaron",
              code: "HAS_OVERDUE_PENDING_REQUESTS",
              data: { requests: [OVERDUE] },
            },
            { status: 409 },
          ),
        ),
      );
      const { user } = renderApp(DETAIL);
      await heading();

      await user.click(screen.getByRole("button", { name: "Dar de baja" }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(await within(dialog).findByRole("button", { name: "Sí, dar de baja" }));

      expect(await within(dialog).findByText("Estas solicitudes deben decidirse antes de la baja:")).toBeInTheDocument();
      expect(within(dialog).getByRole("link", { name: /Vacaciones: 2 de noviembre de 2026/ })).toHaveAttribute(
        "href",
        "/solicitudes/req%2F9",
      );
      // The stale "no se cancelará…" preview is replaced by the list.
      expect(within(dialog).queryByText("No se cancelará ninguna solicitud")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("alert")).toHaveTextContent("Tiene solicitudes pendientes que ya empezaron");
      expect(within(dialog).queryByRole("button", { name: "Sí, dar de baja" })).toBeDisabled();
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus());
    });
  });
});

describe("RequestDetailPage 'Volver' from an employee", () => {
  function mockRequest() {
    mockDetail((id) =>
      HttpResponse.json({
        leaveRequest: buildDetail({ id, permissions: { canApprove: false, canReject: false, canCancel: false } }),
      }),
    );
  }

  it("HR with fromEmployeeState: 'Volver al empleado' to the escaped employee path", async () => {
    mockSession(buildUser("HR", { id: "hr-1" }));
    mockRequest();
    renderApp({ pathname: "/solicitudes/req-1", state: { from: "employee", employeeId: "a/b ?c" } });

    const back = await screen.findByRole("link", { name: "Volver al empleado" });
    expect(back).toHaveAttribute("href", "/administracion/empleados/a%2Fb%20%3Fc");
  });

  it("a MANAGER with the same state (cannot open employees) goes back to Aprobaciones instead", async () => {
    mockSession(buildUser("MANAGER"));
    mockRequest();
    renderApp({ pathname: "/solicitudes/req-1", state: { from: "employee", employeeId: "emp-1" } });

    await screen.findByText("Viaje familiar");
    expect(screen.getByRole("link", { name: "Volver a Aprobaciones" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Volver al empleado" })).not.toBeInTheDocument();
  });

  it("ignores a malformed state (empty id)", async () => {
    mockSession(buildUser("HR", { id: "hr-1" }));
    mockRequest();
    renderApp({ pathname: "/solicitudes/req-1", state: { from: "employee", employeeId: "" } });

    await screen.findByText("Viaje familiar");
    expect(screen.queryByRole("link", { name: "Volver al empleado" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Aprobaciones" })).toBeInTheDocument();
  });
});

describe("EmployeeDetailPage: review fixes", () => {
  function mockImpactOnce(impact: ReturnType<typeof buildDeactivationImpact>) {
    server.use(http.get("/api/hr/employees/:id/deactivation-impact", () => HttpResponse.json(impact)));
  }

  async function openDeactivate(user: ReturnType<typeof renderApp>["user"]) {
    await heading();
    await user.click(screen.getByRole("button", { name: "Dar de baja" }));
    return screen.findByRole("alertdialog", { name: `¿Dar de baja a ${NAME}?` });
  }

  it("the admin sub-menu keeps 'Empleados' highlighted on a detail, without claiming it is the current page", async () => {
    mockSession(buildUser("HR"));
    mockEmployee();
    renderApp(DETAIL);
    await heading();
    const subnav = screen.getByRole("navigation", { name: "Secciones de administración" });
    const employees = within(subnav).getByRole("link", { name: "Empleados" });
    expect(employees).toHaveAttribute("aria-current", "true");
    // No other section says it is the current page either.
    expect(within(subnav).queryByRole("link", { current: "page" })).not.toBeInTheDocument();
  });

  it("on the list itself, 'Empleados' is the current page", async () => {
    mockSession(buildUser("HR"));
    renderApp("/administracion/empleados");
    const subnav = await screen.findByRole("navigation", { name: "Secciones de administración" });
    expect(within(subnav).getByRole("link", { name: "Empleados" })).toHaveAttribute("aria-current", "page");
  });

  it("deactivation warns about an APPROVED leave still running after today (final settlement)", async () => {
    mockSession(buildUser("HR"));
    mockEmployee();
    mockImpactOnce(buildDeactivationImpact({ startedApproved: 1, approvedRunningPastToday: 1 }));
    const { user } = renderApp(DETAIL);
    const dialog = await openDeactivate(user);
    await waitFor(() => expect(dialog).toHaveTextContent("1 de ellas sigue en curso después de hoy"));
    expect(dialog).toHaveTextContent("Revisa si el finiquito necesita un ajuste de saldo");
    // A warning, not a blocker: confirming is still offered.
    expect(within(dialog).getByRole("button", { name: "Sí, dar de baja" })).toBeEnabled();
  });

  it("without APPROVED leave running past today there is no settlement warning", async () => {
    mockSession(buildUser("HR"));
    mockEmployee();
    mockImpactOnce(buildDeactivationImpact({ startedApproved: 1, approvedRunningPastToday: 0 }));
    const { user } = renderApp(DETAIL);
    const dialog = await openDeactivate(user);
    await within(dialog).findByRole("button", { name: "Sí, dar de baja" });
    expect(dialog).not.toHaveTextContent("finiquito");
  });

  it("an unknown blocker code shows a generic reason (never a made-up one) and offers no confirmation", async () => {
    mockSession(buildUser("HR"));
    mockEmployee();
    // A code a newer server could send that this client does not know.
    mockImpactOnce(buildDeactivationImpact({ blocker: "SOMETHING_NEW" as unknown as DeactivationImpact["blocker"] }));
    const { user } = renderApp(DETAIL);
    const dialog = await openDeactivate(user);
    await waitFor(() => expect(dialog).toHaveTextContent("Algo impide darle de baja en este momento"));
    expect(dialog).not.toHaveTextContent("No puedes darte de baja");
    expect(within(dialog).queryByRole("button", { name: "Sí, dar de baja" })).not.toBeInTheDocument();
  });

  it("CANNOT_DEACTIVATE_SELF uses neutral wording", async () => {
    mockSession(buildUser("HR"));
    mockEmployee();
    mockImpactOnce(buildDeactivationImpact({ blocker: "CANNOT_DEACTIVATE_SELF" }));
    const { user } = renderApp(DETAIL);
    const dialog = await openDeactivate(user);
    await waitFor(() => expect(dialog).toHaveTextContent("No puedes darte de baja a ti; pídeselo a otra persona de RH."));
    expect(dialog).not.toHaveTextContent("a ti misma");
  });
});
