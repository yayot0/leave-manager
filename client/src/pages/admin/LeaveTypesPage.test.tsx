import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { HrLeaveType } from "@/api/types";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildHrLeaveType, buildUser, PERSONAL_TYPE, VACATION_TYPE } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

const VACATION = buildHrLeaveType({ ...VACATION_TYPE, requestCount: 12 });
const PERSONAL = buildHrLeaveType({ ...PERSONAL_TYPE, requestCount: 4, updatedAt: "2026-02-01T10:00:00.000Z" });
const OLD = buildHrLeaveType({
  id: "type-old",
  code: "OLD",
  name: "Permiso antiguo",
  countsAgainstVacationBalance: false,
  maxBusinessDaysPerRequest: 3,
  isActive: false,
  requestCount: 2,
});

function mockLeaveTypes(initial: HrLeaveType[]) {
  const state = { current: initial };
  server.use(http.get("/api/hr/leave-types", () => HttpResponse.json({ leaveTypes: state.current })));
  return state;
}

function mockPatch(respond: (body: unknown) => Response) {
  const bodies: unknown[] = [];
  server.use(
    http.patch("/api/hr/leave-types/:id", async ({ request }) => {
      const body = await request.json();
      bodies.push(body);
      return respond(body);
    }),
  );
  return bodies;
}

function table() {
  return screen.findByRole("table", { name: "Tipos de permiso" });
}

function rowOf(tableElement: HTMLElement, name: string): HTMLElement {
  const row = within(tableElement).getByText(name).closest("tr");
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

const MAX_LABEL = "Máximo de días hábiles por solicitud (opcional)";

describe("LeaveTypesPage", () => {
  it("lists every type, inactive ones included, with status as text and its limit", async () => {
    mockSession(buildUser("HR"));
    mockLeaveTypes([VACATION, PERSONAL, OLD]);
    renderApp("/administracion/tipos-de-permiso");

    const tableElement = await table();
    const vacation = rowOf(tableElement, "Vacaciones");
    expect(vacation).toHaveTextContent("VAC");
    expect(vacation).toHaveTextContent("Sí");
    expect(vacation).toHaveTextContent("Sin límite");
    expect(vacation).toHaveTextContent("Activo");
    expect(rowOf(tableElement, "Permiso personal")).toHaveTextContent("1 día hábil por solicitud");
    const old = rowOf(tableElement, "Permiso antiguo");
    expect(old).toHaveTextContent("Inactivo");
    expect(within(old).getByRole("button", { name: "Reactivar Permiso antiguo" })).toBeInTheDocument();
    // The name is the row header.
    expect(within(old).getByRole("rowheader")).toHaveTextContent("Permiso antiguo");
  });

  it("shows the same data as cards for phones", async () => {
    mockSession(buildUser("HR"));
    mockLeaveTypes([PERSONAL, OLD]);
    renderApp("/administracion/tipos-de-permiso");

    const cards = await screen.findByRole("list", { name: "Tipos de permiso" });
    const [personal, old] = within(cards).getAllByRole("listitem");
    expect(personal).toHaveTextContent("PERSONAL");
    expect(personal).toHaveTextContent("1 día hábil por solicitud");
    expect(old).toHaveTextContent("Inactivo");
    expect(within(old).getByRole("button", { name: "Editar Permiso antiguo" })).toBeInTheDocument();
  });

  it("shows a loading state, then an empty state", async () => {
    mockSession(buildUser("HR"));
    const gate = deferred();
    server.use(
      http.get("/api/hr/leave-types", async () => {
        await gate.promise;
        return HttpResponse.json({ leaveTypes: [] });
      }),
    );
    renderApp("/administracion/tipos-de-permiso");

    expect(await screen.findByText("Cargando tipos de permiso…")).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByRole("heading", { level: 2, name: "Aún no hay tipos de permiso" })).toBeInTheDocument();
  });

  it("shows an error with Reintentar", async () => {
    mockSession(buildUser("HR"));
    server.use(http.get("/api/hr/leave-types", () => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 })));
    const { user } = renderApp("/administracion/tipos-de-permiso");

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar los tipos de permiso");
    mockLeaveTypes([VACATION]);
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await table()).toBeInTheDocument();
  });

  it("creates a type: uppercases the code, validates, focuses the first invalid field and sends the fields", async () => {
    mockSession(buildUser("HR"));
    mockLeaveTypes([VACATION]);
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/hr/leave-types", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          { leaveType: buildHrLeaveType({ id: "type-new", code: "MUDANZA", name: "Mudanza" }) },
          { status: 201 },
        );
      }),
    );
    const { user } = renderApp("/administracion/tipos-de-permiso");
    await table();

    await user.click(screen.getByRole("button", { name: "Nuevo tipo de permiso" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo tipo de permiso" });
    const code = within(dialog).getByLabelText("Código");
    // The format hint is always there, linked to the field.
    expect(code).toHaveAccessibleDescription(/Mayúsculas, números o _.*No se puede cambiar/);
    expect(code).toBeRequired();
    await user.type(code, "m");
    await user.type(within(dialog).getByLabelText("Nombre"), "Mudanza");
    const max = within(dialog).getByLabelText(MAX_LABEL);
    await user.type(max, "0");
    await user.click(within(dialog).getByRole("button", { name: "Crear tipo" }));

    expect(code).toHaveValue("M");
    expect(code).toHaveAttribute("aria-invalid", "true");
    // First invalid field on screen gets focus.
    expect(code).toHaveFocus();
    expect(max).toHaveAttribute("aria-invalid", "true");
    expect(max).toHaveAccessibleDescription(/número entero de 1 a 365.*Déjalo vacío/);
    expect(bodies).toEqual([]);

    await user.type(code, "udanza");
    await user.clear(max);
    await user.type(max, "1");
    await user.click(within(dialog).getByRole("button", { name: "Crear tipo" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([
      { code: "MUDANZA", name: "Mudanza", countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 1 },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent('Tipo "Mudanza" creado.');
  });

  it("shows a duplicate code (409 DUPLICATE_CODE) under the code field and focuses it", async () => {
    mockSession(buildUser("HR"));
    mockLeaveTypes([VACATION]);
    server.use(
      http.post("/api/hr/leave-types", () =>
        HttpResponse.json({ error: "Ya existe un tipo de permiso con ese código", code: "DUPLICATE_CODE" }, { status: 409 }),
      ),
    );
    const { user } = renderApp("/administracion/tipos-de-permiso");
    await table();

    await user.click(screen.getByRole("button", { name: "Nuevo tipo de permiso" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Código"), "VAC");
    await user.type(within(dialog).getByLabelText("Nombre"), "Vacaciones extra");
    await user.click(within(dialog).getByRole("button", { name: "Crear tipo" }));

    const code = within(dialog).getByLabelText("Código");
    await waitFor(() => expect(code).toHaveAttribute("aria-invalid", "true"));
    expect(code).toHaveAccessibleDescription(/Ya existe un tipo de permiso con ese código/);
    expect(code).toHaveFocus();
    expect(within(dialog).getByLabelText("Nombre")).not.toHaveAttribute("aria-invalid");
  });

  it("shows the Art. 78 rule (LIMIT_BELOW_LFT_MINIMUM) under the limit field", async () => {
    mockSession(buildUser("HR"));
    mockLeaveTypes([VACATION]);
    const message =
      "Un tipo que descuenta vacaciones no puede limitar las solicitudes a menos de 12 días hábiles: el Art. 78 de la LFT garantiza al menos 12 días continuos.";
    mockPatch(() => HttpResponse.json({ error: message, code: "LIMIT_BELOW_LFT_MINIMUM" }, { status: 400 }));
    const { user } = renderApp("/administracion/tipos-de-permiso");

    await user.click(within(await table()).getByRole("button", { name: "Editar Vacaciones" }));
    const dialog = await screen.findByRole("dialog");
    const max = within(dialog).getByLabelText(MAX_LABEL);
    await user.type(max, "5");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(max).toHaveAttribute("aria-invalid", "true"));
    expect(max).toHaveAccessibleDescription(/Art\. 78 de la LFT/);
    expect(max).toHaveFocus();
  });

  it("edits a type sending only what changed, never the code, with the version it loaded", async () => {
    mockSession(buildUser("HR"));
    mockLeaveTypes([PERSONAL]);
    const bodies = mockPatch(() => HttpResponse.json({ leaveType: { ...PERSONAL, maxBusinessDaysPerRequest: null } }));
    const { user } = renderApp("/administracion/tipos-de-permiso");

    await user.click(within(await table()).getByRole("button", { name: "Editar Permiso personal" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar Permiso personal" });
    expect(dialog).toHaveTextContent("Los cambios solo aplican a solicitudes nuevas");
    expect(dialog).toHaveTextContent("Código: PERSONAL (no se puede cambiar)");
    expect(within(dialog).queryByLabelText("Código")).not.toBeInTheDocument();
    const max = within(dialog).getByLabelText(MAX_LABEL);
    expect(max).toHaveValue(1);
    await user.clear(max);
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Only the limit (the name and "descuenta" did not change): a concurrent
    // edit of another field is not overwritten.
    expect(bodies).toEqual([{ maxBusinessDaysPerRequest: null, expectedUpdatedAt: "2026-02-01T10:00:00.000Z" }]);
  });

  it("closes without calling the API when nothing changed", async () => {
    mockSession(buildUser("HR"));
    mockLeaveTypes([PERSONAL]);
    const bodies = mockPatch(() => HttpResponse.json({ leaveType: PERSONAL }));
    const { user } = renderApp("/administracion/tipos-de-permiso");

    await user.click(within(await table()).getByRole("button", { name: "Editar Permiso personal" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([]);
  });

  it("after STALE_DATA (someone else saved first) explains it and leaves only Volver", async () => {
    mockSession(buildUser("HR"));
    const state = mockLeaveTypes([PERSONAL]);
    mockPatch(() => {
      state.current = [{ ...PERSONAL, maxBusinessDaysPerRequest: 3, updatedAt: "2026-02-02T10:00:00.000Z" }];
      return HttpResponse.json(
        { error: "Alguien más cambió este tipo de permiso mientras lo editabas", code: "STALE_DATA" },
        { status: 409 },
      );
    });
    const { user } = renderApp("/administracion/tipos-de-permiso");

    await user.click(within(await table()).getByRole("button", { name: "Editar Permiso personal" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Nombre");
    await user.clear(name);
    await user.type(name, "Día personal");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Alguien más lo cambió");
    expect(within(dialog).queryByRole("button", { name: "Guardar cambios" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toBeEnabled();

    // The list refreshed behind the dialog with the other person's change
    // (the modal hides the page from the accessibility tree until it closes).
    await user.click(within(dialog).getByRole("button", { name: "Volver" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await within(await table()).findByText("3 días hábiles por solicitud")).toBeInTheDocument();
  });

  it("deactivates a type after confirming, explaining its requests are kept", async () => {
    mockSession(buildUser("HR"));
    const state = mockLeaveTypes([PERSONAL]);
    const bodies = mockPatch(() => {
      state.current = [{ ...PERSONAL, isActive: false }];
      return HttpResponse.json({ leaveType: state.current[0] });
    });
    const { user } = renderApp("/administracion/tipos-de-permiso");

    const opener = within(await table()).getByRole("button", { name: "Desactivar Permiso personal" });
    await user.click(opener);
    const dialog = await screen.findByRole("alertdialog", { name: "¿Desactivar Permiso personal?" });
    expect(dialog).toHaveTextContent("Ya no se ofrecerá en Nueva solicitud. Sus 4 solicitudes no cambian");
    await user.click(within(dialog).getByRole("button", { name: "Sí, desactivar" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([{ isActive: false, expectedUpdatedAt: "2026-02-01T10:00:00.000Z" }]);
    expect(screen.getByRole("status")).toHaveTextContent('Tipo "Permiso personal" desactivado.');
    expect(await within(await table()).findByText("Inactivo")).toBeInTheDocument();
  });

  it("refreshes the employees' catalog and marks cached requests stale after a change", async () => {
    mockSession(buildUser("HR"));
    mockLeaveTypes([PERSONAL]);
    mockPatch(() => HttpResponse.json({ leaveType: { ...PERSONAL, isActive: false } }));
    const { user, queryClient } = renderApp("/administracion/tipos-de-permiso");
    queryClient.setQueryData(["leave-types"], [PERSONAL_TYPE]);
    queryClient.setQueryData(["leave-requests", "mine"], []);

    await user.click(within(await table()).getByRole("button", { name: "Desactivar Permiso personal" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Sí, desactivar" }));

    await waitFor(() => expect(queryClient.getQueryState(["leave-types"])?.isInvalidated).toBe(true));
    // Requests carry the type's name: marked stale (refetched when shown next).
    expect(queryClient.getQueryState(["leave-requests", "mine"])?.isInvalidated).toBe(true);
  });
});
