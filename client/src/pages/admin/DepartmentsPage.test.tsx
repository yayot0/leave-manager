import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { Department } from "@/api/types";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildDepartment, buildUser } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

const VENTAS = buildDepartment({ id: "dep-ventas", name: "Ventas", employeeCount: 3 });
const LEGAL = buildDepartment({ id: "dep-legal", name: "Legal", employeeCount: 0 });

/** GET returns `current`; each test can change it to simulate the refresh after a change. */
function mockDepartments(initial: Department[]) {
  const state = { current: initial, gets: 0 };
  server.use(
    http.get("/api/hr/departments", () => {
      state.gets++;
      return HttpResponse.json({ departments: state.current });
    }),
  );
  return state;
}

function table() {
  return screen.findByRole("table", { name: "Departamentos" });
}

describe("DepartmentsPage", () => {
  it("lists departments with their employees, as a table and as cards", async () => {
    mockSession(buildUser("HR"));
    mockDepartments([LEGAL, VENTAS]);
    renderApp("/administracion/departamentos");

    const rows = within(await table()).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Legal");
    expect(rows[2]).toHaveTextContent("Ventas");
    expect(rows[2]).toHaveTextContent("3");
    const cards = screen.getByRole("list", { name: "Departamentos" });
    expect(within(cards).getAllByRole("listitem")[1]).toHaveTextContent("3 empleados");
  });

  it("shows a loading state, then an empty state", async () => {
    mockSession(buildUser("HR"));
    const gate = deferred();
    server.use(
      http.get("/api/hr/departments", async () => {
        await gate.promise;
        return HttpResponse.json({ departments: [] });
      }),
    );
    renderApp("/administracion/departamentos");

    expect(await screen.findByText("Cargando departamentos…")).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByRole("heading", { level: 2, name: "Aún no hay departamentos" })).toBeInTheDocument();
  });

  it("shows an error with Reintentar", async () => {
    mockSession(buildUser("HR"));
    server.use(http.get("/api/hr/departments", () => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 })));
    const { user } = renderApp("/administracion/departamentos");

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar los departamentos");
    mockDepartments([VENTAS]);
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await table()).toBeInTheDocument();
  });

  it("creates a department: validates the name, sends it trimmed and announces it", async () => {
    mockSession(buildUser("HR"));
    const state = mockDepartments([VENTAS]);
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/hr/departments", async ({ request }) => {
        bodies.push(await request.json());
        state.current = [LEGAL, VENTAS];
        return HttpResponse.json({ department: LEGAL }, { status: 201 });
      }),
    );
    const { user } = renderApp("/administracion/departamentos");
    await table();

    await user.click(screen.getByRole("button", { name: "Nuevo departamento" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo departamento" });
    const name = within(dialog).getByLabelText("Nombre");
    await waitFor(() => expect(name).toHaveFocus());

    // Too short: stopped here, nothing sent.
    await user.type(name, " L ");
    await user.click(within(dialog).getByRole("button", { name: "Crear departamento" }));
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(/al menos 2 caracteres/);
    expect(bodies).toEqual([]);

    await user.clear(name);
    await user.type(name, "  Legal  ");
    expect(name).not.toHaveAttribute("aria-invalid");
    await user.click(within(dialog).getByRole("button", { name: "Crear departamento" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([{ name: "Legal" }]);
    expect(screen.getByRole("status")).toHaveTextContent('Departamento "Legal" creado.');
    // The list is refreshed.
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Departamentos" })).getAllByRole("row")).toHaveLength(3));
  });

  it("shows a duplicate name (409 DUPLICATE_NAME) under the field and keeps the dialog open", async () => {
    mockSession(buildUser("HR"));
    mockDepartments([VENTAS]);
    server.use(
      http.post("/api/hr/departments", () =>
        HttpResponse.json({ error: "Ya existe un departamento con ese nombre", code: "DUPLICATE_NAME" }, { status: 409 }),
      ),
    );
    const { user } = renderApp("/administracion/departamentos");
    await table();

    await user.click(screen.getByRole("button", { name: "Nuevo departamento" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nombre"), "ventas");
    await user.click(within(dialog).getByRole("button", { name: "Crear departamento" }));

    const name = within(dialog).getByLabelText("Nombre");
    await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
    expect(name).toHaveAccessibleDescription("Ya existe un departamento con ese nombre");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renames a department, with the dialog prefilled and the id escaped", async () => {
    mockSession(buildUser("HR"));
    const weird = buildDepartment({ id: "a/b", name: "Ventas" });
    mockDepartments([weird]);
    let path = "";
    server.use(
      http.patch("/api/hr/departments/:id", ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ department: { ...weird, name: "Ventas Norte" } });
      }),
    );
    const { user } = renderApp("/administracion/departamentos");

    await user.click(within(await table()).getByRole("button", { name: "Renombrar Ventas" }));
    const dialog = await screen.findByRole("dialog", { name: "Renombrar Ventas" });
    const name = within(dialog).getByLabelText("Nombre");
    expect(name).toHaveValue("Ventas");
    await user.clear(name);
    await user.type(name, "Ventas Norte");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(path).toBe("/api/hr/departments/a%2Fb");
    expect(screen.getByRole("status")).toHaveTextContent('Departamento renombrado a "Ventas Norte".');
  });

  it("does not offer deleting a department with employees, and explains why", async () => {
    mockSession(buildUser("HR"));
    mockDepartments([VENTAS]);
    const { user } = renderApp("/administracion/departamentos");

    await user.click(within(await table()).getByRole("button", { name: "Borrar Ventas" }));
    const dialog = await screen.findByRole("alertdialog", { name: "No se puede borrar Ventas" });
    expect(dialog).toHaveTextContent("Tiene 3 empleados (contando inactivos)");
    expect(within(dialog).queryByRole("button", { name: "Sí, borrar" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toBeEnabled();
  });

  it("deletes an empty department after confirming", async () => {
    mockSession(buildUser("HR"));
    const state = mockDepartments([LEGAL, VENTAS]);
    let deleted = "";
    server.use(
      http.delete("/api/hr/departments/:id", ({ params }) => {
        deleted = String(params.id);
        state.current = [VENTAS];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp("/administracion/departamentos");

    await user.click(within(await table()).getByRole("button", { name: "Borrar Legal" }));
    const dialog = await screen.findByRole("alertdialog", { name: "¿Borrar Legal?" });
    await user.click(within(dialog).getByRole("button", { name: "Sí, borrar" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(deleted).toBe("dep-legal");
    expect(screen.getByRole("status")).toHaveTextContent('Departamento "Legal" borrado.');
    await waitFor(() => expect(screen.queryByRole("button", { name: "Borrar Legal" })).not.toBeInTheDocument());
    // Its row is gone: focus goes to the page heading, not to <body>.
    expect(screen.getByRole("heading", { level: 1, name: "Departamentos" })).toHaveFocus();
  });

  it("after a 409 (an employee was assigned meanwhile) leaves only Volver, with the error inside", async () => {
    mockSession(buildUser("HR"));
    const state = mockDepartments([LEGAL]);
    server.use(
      http.delete("/api/hr/departments/:id", () => {
        state.current = [{ ...LEGAL, employeeCount: 1 }];
        return HttpResponse.json(
          { error: "No se puede borrar un departamento con empleados; reasígnalos primero", code: "DEPARTMENT_HAS_EMPLOYEES" },
          { status: 409 },
        );
      }),
    );
    const { user } = renderApp("/administracion/departamentos");

    await user.click(within(await table()).getByRole("button", { name: "Borrar Legal" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Sí, borrar" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("reasígnalos primero");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus();
    // The list refreshed behind the dialog.
    await waitFor(() => expect(state.gets).toBeGreaterThan(1));
  });

  it("keeps the dialog and its 404 on screen when the row disappears behind it, then focuses the h1", async () => {
    mockSession(buildUser("HR"));
    const state = mockDepartments([LEGAL, VENTAS]);
    server.use(
      http.delete("/api/hr/departments/:id", () => {
        // Someone else deleted it meanwhile: the refresh removes its row.
        state.current = [VENTAS];
        return HttpResponse.json({ error: "Departamento no encontrado" }, { status: 404 });
      }),
    );
    const { user } = renderApp("/administracion/departamentos");

    await user.click(within(await table()).getByRole("button", { name: "Borrar Legal" }));
    const dialog = await screen.findByRole("alertdialog", { name: "¿Borrar Legal?" });
    await user.click(within(dialog).getByRole("button", { name: "Sí, borrar" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Ya no existe");
    // The row is gone behind the dialog...
    await waitFor(() => expect(screen.queryByRole("button", { name: "Borrar Legal" })).not.toBeInTheDocument());
    // ...but the dialog stays, with only "Volver", focused.
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Ya no existe");
    expect(within(dialog).getByRole("button", { name: "Sí, borrar" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Volver" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "Departamentos" })).toHaveFocus();
  });

  it("while saving shows Guardando…, blocks a second submit and Escape, and sends once", async () => {
    mockSession(buildUser("HR"));
    mockDepartments([VENTAS]);
    const gate = deferred();
    let posts = 0;
    server.use(
      http.post("/api/hr/departments", async () => {
        posts++;
        await gate.promise;
        return HttpResponse.json({ department: LEGAL }, { status: 201 });
      }),
    );
    const { user } = renderApp("/administracion/departamentos");
    await table();

    await user.click(screen.getByRole("button", { name: "Nuevo departamento" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nombre"), "Legal");
    await user.click(within(dialog).getByRole("button", { name: "Crear departamento" }));

    const saving = await within(dialog).findByRole("button", { name: "Guardando…" });
    expect(saving).toBeDisabled();
    expect(within(dialog).getByLabelText("Nombre")).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Cerrar" })).not.toBeInTheDocument();
    await user.click(saving);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(posts).toBe(1);

    gate.resolve();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts).toBe(1);
  });

  it("focuses the name after a duplicate-name 409, and returns focus to the opener on Volver", async () => {
    mockSession(buildUser("HR"));
    mockDepartments([VENTAS]);
    server.use(
      http.patch("/api/hr/departments/:id", () =>
        HttpResponse.json({ error: "Ya existe un departamento con ese nombre", code: "DUPLICATE_NAME" }, { status: 409 }),
      ),
    );
    const { user } = renderApp("/administracion/departamentos");

    const opener = within(await table()).getByRole("button", { name: "Renombrar Ventas" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Nombre");
    await user.clear(name);
    await user.type(name, "Legal");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveAttribute("aria-invalid", "true");

    await user.click(within(dialog).getByRole("button", { name: "Volver" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Its row is still there: back to the button that opened it.
    expect(opener).toHaveFocus();
  });
});
