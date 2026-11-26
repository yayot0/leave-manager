import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { EmployeeDetail, HireDateImpact, ManagerOption } from "@/api/types";
import { renderApp } from "@/test/render";
import { mockEmployeeDetail, mockSession, server } from "@/test/server";
import { buildBalance, buildDepartment, buildEmployee, buildEmployeeDetail, buildUser } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

const LIST = "/administracion/empleados";
const DETAIL = "/administracion/empleados/emp-1";
const IMPACT_DEBOUNCE_MS = 400;
const TEMP_PASSWORD = "nube-tortuga-faro-mango-27";

const MANAGERS: ManagerOption[] = [
  { id: "mgr-1", firstName: "Ricardo", lastName: "Montemayor", role: "MANAGER", department: { id: "dep-1", name: "Tecnología" } },
  { id: "hr-2", firstName: "Sofía", lastName: "Treviño", role: "HR", department: null },
  // The employee being edited is also a manager option (e.g. a MANAGER): never offered as their own boss.
  { id: "emp-1", firstName: "Laura", lastName: "Méndez Ortiz", role: "MANAGER", department: null },
];

function mockCatalogs() {
  server.use(
    http.get("/api/hr/departments", () =>
      HttpResponse.json({
        departments: [buildDepartment({ id: "dep-1", name: "Tecnología" }), buildDepartment({ id: "dep-2", name: "Ventas" })],
      }),
    ),
    http.get("/api/hr/employees/manager-options", () => HttpResponse.json({ managers: MANAGERS })),
  );
}

function mockEmployee(employee: EmployeeDetail = buildEmployeeDetail()) {
  const state = { current: employee };
  mockEmployeeDetail(() => HttpResponse.json({ employee: state.current }));
  return state;
}

function mockPatch(respond: (body: Record<string, unknown>) => Response) {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.patch("/api/hr/employees/:id", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      return respond(body);
    }),
  );
  return bodies;
}

const ok = () => HttpResponse.json({ employee: buildEmployee() });

async function openEdit(user: ReturnType<typeof renderApp>["user"]) {
  await screen.findByRole("heading", { level: 1, name: "Laura Méndez Ortiz" });
  await user.click(screen.getByRole("button", { name: "Editar datos" }));
  const dialog = await screen.findByRole("dialog", { name: "Editar a Laura Méndez Ortiz" });
  // Wait for the catalogs, so the selects hold their values.
  await waitFor(() => expect(within(dialog).getByLabelText("Departamento")).toHaveValue("dep-1"));
  await waitFor(() => expect(within(dialog).getByLabelText("Jefe directo")).toBeEnabled());
  return dialog;
}

function setDate(dialog: HTMLElement, value: string) {
  fireEvent.change(within(dialog).getByLabelText("Fecha de ingreso"), { target: { value } });
}

function snapshot(available: number, earned: number, yearsOfService: number) {
  const { asOf: _asOf, ...rest } = buildBalance({ available, earned, yearsOfService });
  return rest;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EmployeeFormDialog: create", () => {
  it("opens with the focus on Nombre and validates required fields, focusing the first invalid one", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    let posts = 0;
    server.use(
      http.post("/api/hr/employees", () => {
        posts++;
        return HttpResponse.json({});
      }),
    );
    const { user } = renderApp(LIST);
    await user.click(await screen.findByRole("button", { name: "Nuevo empleado" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo empleado" });
    expect(dialog).toHaveTextContent("Se generará una contraseña temporal que verás una sola vez.");
    const firstName = within(dialog).getByLabelText("Nombre");
    await waitFor(() => expect(firstName).toHaveFocus());

    await user.click(within(dialog).getByRole("button", { name: "Crear empleado" }));
    expect(firstName).toHaveFocus();
    expect(firstName).toHaveAttribute("aria-invalid", "true");
    expect(firstName).toHaveAccessibleDescription("Escribe un nombre de al menos 2 caracteres.");
    expect(within(dialog).getByLabelText("Apellidos")).toHaveAccessibleDescription(
      "Escribe los apellidos de al menos 2 caracteres.",
    );
    expect(within(dialog).getByLabelText("Correo")).toHaveAccessibleDescription(/Escribe un correo válido/);
    expect(within(dialog).getByLabelText("Departamento")).toHaveAccessibleDescription("Elige un departamento.");
    expect(within(dialog).getByLabelText("Fecha de ingreso")).toHaveAccessibleDescription(/Elige la fecha de ingreso\./);

    // A name of a single (trimmed) letter is still too short; the next invalid field gets focus.
    await user.type(firstName, " A ");
    await user.type(within(dialog).getByLabelText("Apellidos"), "López");
    await user.type(within(dialog).getByLabelText("Correo"), "ana@empresa");
    await user.click(within(dialog).getByRole("button", { name: "Crear empleado" }));
    expect(firstName).toHaveFocus();
    await user.clear(firstName);
    await user.type(firstName, "Ana");
    await user.click(within(dialog).getByRole("button", { name: "Crear empleado" }));
    expect(within(dialog).getByLabelText("Correo")).toHaveFocus();
    expect(posts).toBe(0);
  });

  it("sends the whole employee (email trimmed and lowercased) and shows the temporary password ONCE in the same dialog", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/hr/employees", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          {
            temporaryPassword: TEMP_PASSWORD,
            employee: buildEmployee({ id: "emp-9", firstName: "Ana", lastName: "López", email: "ana.lopez@empresa.com" }),
          },
          { status: 201 },
        );
      }),
    );
    const { user, queryClient } = renderApp(LIST);
    await user.click(await screen.findByRole("button", { name: "Nuevo empleado" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo empleado" });
    await waitFor(() => expect(within(dialog).getByLabelText("Jefe directo")).toBeEnabled());

    // The manager options show role and department.
    const manager = within(dialog).getByLabelText("Jefe directo");
    expect(within(manager).getByRole("option", { name: "Ricardo Montemayor · Jefe de área · Tecnología" })).toBeInTheDocument();
    expect(within(manager).getByRole("option", { name: "Sofía Treviño · Recursos Humanos" })).toBeInTheDocument();
    expect(manager).toHaveValue("");

    await user.type(within(dialog).getByLabelText("Nombre"), "  Ana ");
    await user.type(within(dialog).getByLabelText("Apellidos"), "López");
    await user.type(within(dialog).getByLabelText("Correo"), " Ana.Lopez@Empresa.COM ");
    await user.selectOptions(within(dialog).getByLabelText("Rol"), "MANAGER");
    await user.selectOptions(within(dialog).getByLabelText("Departamento"), "dep-2");
    await user.selectOptions(manager, "hr-2");
    setDate(dialog, "2024-02-29");

    // A MANAGER account: HR will see its password, so the stronger warning
    // and its checkbox are required (same as resetting such an account).
    expect(dialog).toHaveTextContent("Cuidado: es una cuenta de Jefe de área");
    const acknowledgement = within(dialog).getByRole("checkbox", { name: /podría aprobar o rechazar solicitudes de su equipo en nombre de Ana/ });
    await user.click(within(dialog).getByRole("button", { name: "Crear empleado" }));
    expect(bodies).toEqual([]);
    expect(acknowledgement).toHaveFocus();
    expect(dialog).toHaveTextContent("Marca la casilla para continuar.");
    await user.click(acknowledgement);
    await user.click(within(dialog).getByRole("button", { name: "Crear empleado" }));

    const password = await within(dialog).findByLabelText("Contraseña temporal");
    expect(bodies).toEqual([
      {
        firstName: "Ana",
        lastName: "López",
        email: "ana.lopez@empresa.com",
        role: "MANAGER",
        departmentId: "dep-2",
        managerId: "hr-2",
        hireDate: "2024-02-29",
      },
    ]);
    expect(within(dialog).getByRole("heading", { name: "Ana López ya tiene cuenta" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Entrégala solo a Ana López.");
    expect(password).toHaveValue(TEMP_PASSWORD);
    await waitFor(() => expect(password).toHaveFocus());
    expect(within(dialog).getByText("No se volverá a mostrar")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Crear empleado" })).not.toBeInTheDocument();
    expect(screen.getByText("Empleado Ana López creado.")).toBeInTheDocument();
    await waitFor(() => {
      const caches = JSON.stringify({
        queries: queryClient.getQueryCache().getAll().map((query) => query.state),
        mutations: queryClient.getMutationCache().getAll().map((mutation) => mutation.state),
      });
      expect(caches).not.toContain(TEMP_PASSWORD);
    });

    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(within(dialog).getByRole("button", { name: "Copiar" }));
    expect(writeText).toHaveBeenCalledWith(TEMP_PASSWORD);
    expect(await within(dialog).findByText("Contraseña copiada.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Listo, ya la copié" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent(TEMP_PASSWORD);
    expect(screen.getByRole("button", { name: "Nuevo empleado" })).toHaveFocus();

    // Opening again: an empty form, never the old password.
    await user.click(screen.getByRole("button", { name: "Nuevo empleado" }));
    const again = await screen.findByRole("dialog", { name: "Nuevo empleado" });
    expect(within(again).getByLabelText("Nombre")).toHaveValue("");
    expect(within(again).queryByLabelText("Contraseña temporal")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(TEMP_PASSWORD);
  });

  it("'Sin jefe (decide RH)' sends managerId null; no hire-date preview is asked when creating", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    let impactCalls = 0;
    server.use(
      http.get("/api/hr/employees/:id/hire-date-impact", () => {
        impactCalls++;
        return HttpResponse.json({});
      }),
    );
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post("/api/hr/employees", async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ temporaryPassword: TEMP_PASSWORD, employee: buildEmployee() }, { status: 201 });
      }),
    );
    const { user } = renderApp(LIST);
    await user.click(await screen.findByRole("button", { name: "Nuevo empleado" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("Departamento")).toBeEnabled());

    await user.type(within(dialog).getByLabelText("Nombre"), "Ana");
    await user.type(within(dialog).getByLabelText("Apellidos"), "López");
    await user.type(within(dialog).getByLabelText("Correo"), "ana@empresa.com");
    await user.selectOptions(within(dialog).getByLabelText("Departamento"), "dep-1");
    setDate(dialog, "2026-11-20");
    await new Promise((resolve) => setTimeout(resolve, IMPACT_DEBOUNCE_MS + 100));
    await user.click(within(dialog).getByRole("button", { name: "Crear empleado" }));

    await within(dialog).findByLabelText("Contraseña temporal");
    expect(bodies[0]).toMatchObject({ managerId: null, role: "EMPLOYEE" });
    expect(impactCalls).toBe(0);
  });

  it("DUPLICATE_EMAIL goes under Correo, which gets the focus; the form can be sent again", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    let posts = 0;
    server.use(
      http.post("/api/hr/employees", () => {
        posts++;
        return HttpResponse.json({ error: "Ya existe un empleado con ese correo", code: "DUPLICATE_EMAIL" }, { status: 409 });
      }),
    );
    const { user } = renderApp(LIST);
    await user.click(await screen.findByRole("button", { name: "Nuevo empleado" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("Departamento")).toBeEnabled());
    await user.type(within(dialog).getByLabelText("Nombre"), "Ana");
    await user.type(within(dialog).getByLabelText("Apellidos"), "López");
    await user.type(within(dialog).getByLabelText("Correo"), "laura.mendez@empresa.com");
    await user.selectOptions(within(dialog).getByLabelText("Departamento"), "dep-1");
    setDate(dialog, "2026-11-20");
    await user.click(within(dialog).getByRole("button", { name: "Crear empleado" }));

    const email = within(dialog).getByLabelText("Correo");
    await waitFor(() => expect(email).toHaveAccessibleDescription("Ya existe un empleado con ese correo"));
    expect(email).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(email).toHaveFocus());
    // A field error, not a general alert, and not locked.
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Crear empleado" })).toBeEnabled();
    expect(posts).toBe(1);
  });
});

describe("EmployeeFormDialog: edit", () => {
  it("opens with the current values and does not offer the employee as their own manager", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    mockEmployee();
    const { user } = renderApp(DETAIL);
    const dialog = await openEdit(user);

    expect(within(dialog).getByLabelText("Nombre")).toHaveValue("Laura");
    expect(within(dialog).getByLabelText("Apellidos")).toHaveValue("Méndez Ortiz");
    expect(within(dialog).getByLabelText("Correo")).toHaveValue("laura.mendez@empresa.com");
    expect(within(dialog).getByLabelText("Rol")).toHaveValue("EMPLOYEE");
    expect(within(dialog).getByLabelText("Fecha de ingreso")).toHaveValue("2022-01-10");
    const manager = within(dialog).getByLabelText("Jefe directo");
    expect(manager).toHaveValue("mgr-1");
    expect(within(manager).queryByRole("option", { name: /Laura Méndez Ortiz/ })).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("Solo se guardan los campos que cambies.");
  });

  it("closes without a request when nothing changed (also an email that only differs in case or spaces)", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    mockEmployee();
    const bodies = mockPatch(ok);
    const { user } = renderApp(DETAIL);
    const dialog = await openEdit(user);

    const email = within(dialog).getByLabelText("Correo");
    await user.clear(email);
    await user.type(email, " LAURA.Mendez@empresa.com ");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([]);
  });

  it("sends ONLY the changed fields plus expectedUpdatedAt", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    mockEmployee();
    const bodies = mockPatch(ok);
    const { user } = renderApp(DETAIL);
    const dialog = await openEdit(user);

    const firstName = within(dialog).getByLabelText("Nombre");
    await user.clear(firstName);
    await user.type(firstName, " Laurita ");
    await user.selectOptions(within(dialog).getByLabelText("Jefe directo"), "");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([{ firstName: "Laurita", managerId: null, expectedUpdatedAt: "2026-11-01T15:00:00.000Z" }]);
    expect(screen.getByText("Datos de Laurita Méndez Ortiz guardados.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar datos" })).toHaveFocus();
  });

  it("sends role, department and hire date when only those change", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    mockEmployee();
    server.use(
      http.get("/api/hr/employees/:id/hire-date-impact", () =>
        HttpResponse.json({ asOf: "2026-11-20", current: snapshot(14, 20, 4), proposed: snapshot(14, 20, 4), problem: null }),
      ),
    );
    const bodies = mockPatch(ok);
    const { user } = renderApp(DETAIL);
    const dialog = await openEdit(user);

    await user.selectOptions(within(dialog).getByLabelText("Rol"), "HR");
    await user.selectOptions(within(dialog).getByLabelText("Departamento"), "dep-2");
    setDate(dialog, "2022-01-11");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      role: "HR",
      departmentId: "dep-2",
      hireDate: "2022-01-11",
      expectedUpdatedAt: "2026-11-01T15:00:00.000Z",
    });
  });

  it.each([
    ["MANAGER_CYCLE", "Jefe directo", "Ese jefe le reporta (ciclo)", "mgr-1"],
    ["MANAGER_NOT_ELIGIBLE", "Jefe directo", "Ese jefe no puede decidir solicitudes", "mgr-1"],
    ["HAS_ACTIVE_REPORTS", "Rol", "Tiene personas a su cargo", "role"],
    ["LAST_ACTIVE_HR", "Rol", "Es la única persona activa de RH", "role"],
    ["HIRE_DATE_AFTER_REQUESTS", "Fecha de ingreso", "Tiene solicitudes antes de esa fecha", "date"],
  ])("%s goes under %s, which gets the focus", async (code, label, message, change) => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    mockEmployee(buildEmployeeDetail({ role: "MANAGER", managerId: "hr-2" }));
    server.use(
      http.get("/api/hr/employees/:id/hire-date-impact", () =>
        HttpResponse.json({ asOf: "2026-11-20", current: snapshot(14, 20, 4), proposed: snapshot(14, 20, 4), problem: null }),
      ),
    );
    mockPatch(() => HttpResponse.json({ error: message, code }, { status: code.startsWith("HIRE") ? 400 : 409 }));
    const { user } = renderApp(DETAIL);
    await screen.findByRole("heading", { level: 1, name: "Laura Méndez Ortiz" });
    await user.click(screen.getByRole("button", { name: "Editar datos" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("Jefe directo")).toBeEnabled());
    await waitFor(() => expect(within(dialog).getByLabelText("Departamento")).toHaveValue("dep-1"));

    if (change === "mgr-1") await user.selectOptions(within(dialog).getByLabelText("Jefe directo"), "mgr-1");
    if (change === "role") await user.selectOptions(within(dialog).getByLabelText("Rol"), "EMPLOYEE");
    if (change === "date") setDate(dialog, "2027-01-01");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    const field = within(dialog).getByLabelText(label);
    await waitFor(() => expect(field).toHaveAccessibleDescription(expect.stringContaining(message)));
    expect(field).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(field).toHaveFocus());
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Guardar cambios" })).toBeEnabled();
  });

  it("STALE_DATA: explains someone else saved first and leaves only Volver", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    mockEmployee();
    const bodies = mockPatch(() =>
      HttpResponse.json({ error: "Alguien más cambió a este empleado", code: "STALE_DATA" }, { status: 409 }),
    );
    const { user } = renderApp(DETAIL);
    const dialog = await openEdit(user);

    await user.type(within(dialog).getByLabelText("Apellidos"), " Ruiz");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Alguien más lo cambió");
    expect(within(dialog).queryByRole("button", { name: "Guardar cambios" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toBeEnabled();
    // Enter in a field cannot resend it either.
    await user.type(within(dialog).getByLabelText("Apellidos"), "{Enter}");
    expect(bodies).toHaveLength(1);
  });

  it("disables role, manager and hire date when `permissions` says so, explaining why", async () => {
    mockSession(buildUser("HR", { id: "emp-1" }));
    mockCatalogs();
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
    const { user } = renderApp(DETAIL);
    await screen.findByRole("heading", { level: 1, name: "Laura Méndez Ortiz" });
    await user.click(screen.getByRole("button", { name: "Editar datos" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("Departamento")).toBeEnabled());

    expect(within(dialog).getByLabelText("Rol")).toBeDisabled();
    expect(within(dialog).getByLabelText("Rol")).toHaveAccessibleDescription(/No puedes cambiar tu propio rol/);
    expect(within(dialog).getByLabelText("Jefe directo")).toBeDisabled();
    expect(within(dialog).getByLabelText("Jefe directo")).toHaveAccessibleDescription(/No puedes cambiar tu propio jefe/);
    expect(within(dialog).getByLabelText("Fecha de ingreso")).toBeDisabled();
    expect(within(dialog).getByLabelText("Fecha de ingreso")).toHaveAccessibleDescription(
      /No puedes cambiar tu propia fecha de ingreso/,
    );
    // The rest can still be edited.
    expect(within(dialog).getByLabelText("Nombre")).toBeEnabled();
    expect(within(dialog).getByLabelText("Correo")).toBeEnabled();
  });

  it("keeps showing a current manager who can no longer be one (inactive), so the select does not lie", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    mockEmployee(
      buildEmployeeDetail({
        managerId: "mgr-old",
        manager: { id: "mgr-old", firstName: "Jorge", lastName: "Salas", role: "MANAGER", isActive: false },
      }),
    );
    const bodies = mockPatch(ok);
    const { user } = renderApp(DETAIL);
    await screen.findByRole("heading", { level: 1, name: "Laura Méndez Ortiz" });
    await user.click(screen.getByRole("button", { name: "Editar datos" }));
    const dialog = await screen.findByRole("dialog");
    const manager = within(dialog).getByLabelText("Jefe directo");
    await waitFor(() => expect(manager).toBeEnabled());

    expect(manager).toHaveValue("mgr-old");
    expect(within(manager).getByRole("option", { name: "Jorge Salas (ya no puede ser jefe)" })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Nombre"), "a");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    // Not touched: the manager is not sent.
    expect(bodies[0]).not.toHaveProperty("managerId");
  });

  describe("hire date preview", () => {
    function mockImpact(respond: (hireDate: string) => HireDateImpact) {
      const asked: string[] = [];
      server.use(
        http.get("/api/hr/employees/:id/hire-date-impact", ({ request, params }) => {
          const hireDate = new URL(request.url).searchParams.get("hireDate") ?? "";
          asked.push(`${String(params.id)}:${hireDate}`);
          return HttpResponse.json(respond(hireDate));
        }),
      );
      return asked;
    }

    it("asks only after the date settles (400 ms) and only for the last one", async () => {
      mockSession(buildUser("HR"));
      mockCatalogs();
      mockEmployee();
      const asked = mockImpact(() => ({
        asOf: "2026-11-20",
        current: snapshot(14, 20, 4),
        proposed: snapshot(16, 22, 6),
        problem: null,
      }));
      const { user } = renderApp(DETAIL);
      const dialog = await openEdit(user);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (const date of ["0002-01-10", "0020-01-10", "0202-01-10", "2020-01-10"]) {
        setDate(dialog, date);
        act(() => vi.advanceTimersByTime(IMPACT_DEBOUNCE_MS - 100));
      }
      expect(asked).toEqual([]);
      act(() => vi.advanceTimersByTime(IMPACT_DEBOUNCE_MS));
      act(() => vi.advanceTimersByTime(IMPACT_DEBOUNCE_MS * 10));
      vi.useRealTimers();

      const region = within(dialog).getAllByRole("status").find((element) => element.id && element.closest("form"));
      expect(region).toBeDefined();
      expect(await within(region as HTMLElement).findByText("Su saldo actual sube 2 días")).toBeInTheDocument();
      expect(asked).toEqual(["emp-1:2020-01-10"]);
      expect(region).toHaveTextContent("Hoy14 días disponibles (20 días ganados, 4 años de antigüedad");
      expect(region).toHaveTextContent("Con la nueva fecha16 días disponibles (22 días ganados, 6 años de antigüedad");
      expect(region).toHaveTextContent("periodo 15 de marzo de 2026 al 14 de marzo de 2027");
      // A polite notice, not an alert, and it describes the submit button.
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Guardar cambios" })).toHaveAccessibleDescription(
        /Su saldo actual sube 2 días/,
      );
    });

    it("says when the balance goes down or does not change", async () => {
      mockSession(buildUser("HR"));
      mockCatalogs();
      mockEmployee();
      mockImpact((hireDate) => ({
        asOf: "2026-11-20",
        current: snapshot(14, 20, 4),
        proposed: hireDate === "2023-01-10" ? snapshot(1, 12, 1) : snapshot(14, 20, 4),
        problem: null,
      }));
      const { user } = renderApp(DETAIL);
      const dialog = await openEdit(user);

      setDate(dialog, "2023-01-10");
      expect(await within(dialog).findByText("Su saldo actual baja 13 días")).toBeInTheDocument();
      expect(dialog).toHaveTextContent("1 año de antigüedad");
      setDate(dialog, "2022-01-09");
      expect(await within(dialog).findByText("Su saldo actual no cambia")).toBeInTheDocument();
    });

    it("warns, as the API would refuse it, when a request starts before the new date", async () => {
      mockSession(buildUser("HR"));
      mockCatalogs();
      mockEmployee();
      mockImpact(() => ({
        asOf: "2026-11-20",
        current: snapshot(14, 20, 4),
        proposed: snapshot(0, 0, 0),
        problem: {
          code: "HIRE_DATE_AFTER_REQUESTS",
          message: "Tiene solicitudes activas antes de esa fecha",
          earliestRequestStart: "2026-12-01",
        },
      }));
      const { user } = renderApp(DETAIL);
      const dialog = await openEdit(user);

      setDate(dialog, "2026-12-15");
      expect(await within(dialog).findByText("Esta fecha no se puede guardar")).toBeInTheDocument();
      // A date-only value: 1 December, not 30 November, in Monterrey.
      expect(dialog).toHaveTextContent("Tiene una solicitud activa que empieza el 1 de diciembre de 2026");
    });

    it("explains when the preview cannot be calculated", async () => {
      mockSession(buildUser("HR"));
      mockCatalogs();
      mockEmployee();
      server.use(
        http.get("/api/hr/employees/:id/hire-date-impact", () =>
          HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 }),
        ),
      );
      const { user } = renderApp(DETAIL);
      const dialog = await openEdit(user);

      setDate(dialog, "2020-01-10");
      expect(await within(dialog).findByText(/No se pudo calcular cómo cambia su saldo/)).toBeInTheDocument();
    });

    it("going back to the original date clears the preview and the button description, without asking", async () => {
      mockSession(buildUser("HR"));
      mockCatalogs();
      mockEmployee();
      const asked = mockImpact(() => ({
        asOf: "2026-11-20",
        current: snapshot(14, 20, 4),
        proposed: snapshot(16, 22, 6),
        problem: null,
      }));
      const { user } = renderApp(DETAIL);
      const dialog = await openEdit(user);

      setDate(dialog, "2020-01-10");
      expect(await within(dialog).findByText("Su saldo actual sube 2 días")).toBeInTheDocument();
      setDate(dialog, "2022-01-10");
      await waitFor(() => expect(within(dialog).queryByText("Su saldo actual sube 2 días")).not.toBeInTheDocument());
      await new Promise((resolve) => setTimeout(resolve, IMPACT_DEBOUNCE_MS + 100));
      expect(asked).toEqual(["emp-1:2020-01-10"]);
      expect(within(dialog).getByRole("button", { name: "Guardar cambios" })).not.toHaveAttribute("aria-describedby");
    });
  });
});

describe("EmployeeFormDialog: review fixes", () => {
  it("a general error (STALE_DATA) moves focus to 'Volver', the only way out", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    mockEmployee();
    mockPatch(() =>
      HttpResponse.json(
        { error: "Alguien más modificó a este empleado", code: "STALE_DATA" },
        { status: 409 },
      ),
    );
    const { user } = renderApp(DETAIL);
    const dialog = await openEdit(user);

    const firstName = within(dialog).getByLabelText("Nombre");
    await user.clear(firstName);
    await user.type(firstName, "Lucía");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    expect(await within(dialog).findByText("Alguien más lo cambió")).toBeInTheDocument();
    // Submitting again could never work: the button is gone and focus is not lost to <body>.
    expect(within(dialog).queryByRole("button", { name: "Guardar cambios" })).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus());
  });

  it("while the manager options load, the current manager is shown by name only (no '(ya no puede ser jefe)')", async () => {
    mockSession(buildUser("HR"));
    const gate = deferred();
    server.use(
      http.get("/api/hr/departments", () =>
        HttpResponse.json({ departments: [buildDepartment({ id: "dep-1", name: "Tecnología" })] }),
      ),
      http.get("/api/hr/employees/manager-options", async () => {
        await gate.promise;
        return HttpResponse.json({ managers: MANAGERS });
      }),
    );
    // Her current manager is no longer among the options (e.g. deactivated).
    mockEmployee(
      buildEmployeeDetail({
        managerId: "mgr-old",
        manager: { id: "mgr-old", firstName: "Viejo", lastName: "Jefe", role: "MANAGER", isActive: false },
      }),
    );
    const { user } = renderApp(DETAIL);
    await screen.findByRole("heading", { level: 1, name: "Laura Méndez Ortiz" });
    await user.click(screen.getByRole("button", { name: "Editar datos" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar a Laura Méndez Ortiz" });
    const manager = within(dialog).getByLabelText("Jefe directo");

    // Still loading: the select must not claim the manager is ineligible.
    expect(manager).toBeDisabled();
    expect(within(manager).getByRole("option", { name: "Viejo Jefe" })).toBeInTheDocument();
    expect(manager).toHaveValue("mgr-old");

    gate.resolve();
    await waitFor(() => expect(manager).toBeEnabled());
    expect(within(manager).getByRole("option", { name: "Viejo Jefe (ya no puede ser jefe)" })).toBeInTheDocument();
    expect(manager).toHaveValue("mgr-old");
  });

  it("creating an EMPLOYEE shows no impersonation checkbox", async () => {
    mockSession(buildUser("HR"));
    mockCatalogs();
    const { user } = renderApp(LIST);
    await user.click(await screen.findByRole("button", { name: "Nuevo empleado" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo empleado" });
    expect(within(dialog).getByLabelText("Rol")).toHaveValue("EMPLOYEE");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    // Switching to HR asks for it.
    await user.selectOptions(within(dialog).getByLabelText("Rol"), "HR");
    expect(within(dialog).getByRole("checkbox", { name: /podría administrar empleados y saldos/ })).toBeInTheDocument();
  });
});
