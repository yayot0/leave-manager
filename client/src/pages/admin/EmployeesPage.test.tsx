import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { Employee, EmployeesPage } from "@/api/types";
import { renderApp } from "@/test/render";
import { mockEmployeeDetail, mockSession, server } from "@/test/server";
import { buildDepartment, buildEmployee, buildEmployeeDetail, buildUser } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

const SEARCH_DEBOUNCE_MS = 300;
const LIST = "/administracion/empleados";

const LAURA = buildEmployee();
const OMAR = buildEmployee({
  id: "emp-2",
  email: "omar.ruiz@empresa.com",
  firstName: "Omar",
  lastName: "Ruiz",
  role: "MANAGER",
  hireDate: "2019-02-28",
  department: { id: "dep-2", name: "Ventas" },
  departmentId: "dep-2",
  manager: null,
  managerId: null,
  isActive: false,
});

function page(employees: Employee[], overrides: Partial<EmployeesPage> = {}): EmployeesPage {
  return { employees, page: 1, pageSize: 20, total: employees.length, totalPages: 1, ...overrides };
}

/** GET /api/hr/employees answering with `respond(params)`; records each query string. */
function mockList(respond: (params: URLSearchParams) => EmployeesPage = () => page([LAURA, OMAR])) {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get("/api/hr/employees", ({ request }) => {
      const params = new URL(request.url).searchParams;
      queries.push(params);
      return HttpResponse.json(respond(params));
    }),
  );
  return queries;
}

function mockDepartments() {
  server.use(
    http.get("/api/hr/departments", () =>
      HttpResponse.json({
        departments: [buildDepartment({ id: "dep-1", name: "Tecnología" }), buildDepartment({ id: "dep-2", name: "Ventas" })],
      }),
    ),
  );
}

function search() {
  return screen.getByRole("searchbox", { name: "Buscar" });
}

function summary() {
  return screen.getAllByRole("status").find((element) => /empleado|Buscando|resultados/.test(element.textContent ?? ""));
}

/** The page's search params as a plain object. */
function urlParams(router: ReturnType<typeof renderApp>["router"]) {
  return Object.fromEntries(new URLSearchParams(router.state.location.search));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EmployeesPage", () => {
  it("lists employees as table and cards: role, department, manager, hire date (no timezone shift) and status", async () => {
    mockSession(buildUser("HR"));
    mockDepartments();
    const queries = mockList();
    renderApp(LIST);

    const table = await screen.findByRole("table", { name: "Empleados" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const laura = rows[1];
    expect(within(laura).getByRole("rowheader")).toHaveTextContent("Méndez Ortiz, Laura");
    expect(laura).toHaveTextContent("laura.mendez@empresa.com");
    expect(laura).toHaveTextContent("Empleado");
    expect(laura).toHaveTextContent("Tecnología");
    expect(laura).toHaveTextContent("Ricardo Montemayor");
    // 2022-01-10 in Monterrey (UTC-6) must not become 9 January.
    expect(laura).toHaveTextContent("10 de enero de 2022");
    expect(laura).toHaveTextContent("Activo");
    const omar = rows[2];
    expect(omar).toHaveTextContent("Jefe de área");
    expect(omar).toHaveTextContent("Sin jefe");
    expect(omar).toHaveTextContent("28 de febrero de 2019");
    expect(omar).toHaveTextContent("Dado de baja");

    const cards = within(screen.getByRole("list", { name: "Empleados" })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("Méndez Ortiz, Laura");

    expect(summary()).toHaveTextContent("Mostrando 1–2 de 2 empleados.");
    // Defaults sent explicitly; empty filters are not sent.
    expect(Object.fromEntries(queries[0])).toEqual({ status: "active", page: "1" });
  });

  it("marks Empleados as the current administration section", async () => {
    mockSession(buildUser("HR"));
    mockList();
    renderApp(LIST);

    const subnav = await screen.findByRole("navigation", { name: "Secciones de administración" });
    expect(within(subnav).getByRole("link", { name: "Empleados" })).toHaveAttribute("aria-current", "page");
  });

  it("is closed to EMPLOYEE and MANAGER (list and detail) without calling the API", async () => {
    let calls = 0;
    server.use(
      http.get("/api/hr/employees", () => {
        calls++;
        return HttpResponse.json(page([]));
      }),
    );
    for (const role of ["EMPLOYEE", "MANAGER"] as const) {
      for (const path of [LIST, "/administracion/empleados/emp-1"]) {
        mockSession(buildUser(role));
        const { unmount } = renderApp(path);
        expect(await screen.findByRole("heading", { level: 1, name: "No tienes acceso a esta sección" })).toBeInTheDocument();
        unmount();
      }
    }
    expect(calls).toBe(0);
  });

  it("shows a loading state and an error with Reintentar", async () => {
    mockSession(buildUser("HR"));
    const gate = deferred();
    server.use(
      http.get("/api/hr/employees", async () => {
        await gate.promise;
        return HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 });
      }),
    );
    const { user } = renderApp(LIST);

    expect(await screen.findByText("Cargando empleados…")).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar los empleados");
    mockList();
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("table", { name: "Empleados" })).toBeInTheDocument();
  });

  it("shows an empty state when nobody matches the filters", async () => {
    mockSession(buildUser("HR"));
    mockList(() => page([]));
    renderApp(`${LIST}?q=zz`);

    expect(await screen.findByText("Ningún empleado coincide con los filtros.")).toBeInTheDocument();
    expect(screen.getByText("Prueba con otra búsqueda u otros filtros.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ir a la primera página" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Paginación de empleados" })).not.toBeInTheDocument();
  });

  it("offers 'Ir a la primera página' on a page past the end, keeping the other filters", async () => {
    mockSession(buildUser("HR"));
    const queries = mockList((params) =>
      params.get("page") === "9"
        ? page([], { page: 9, total: 25, totalPages: 2 })
        : page([LAURA], { page: 1, total: 25, totalPages: 2 }),
    );
    const { user, router } = renderApp(`${LIST}?role=MANAGER&page=9`);

    expect(await screen.findByText("No hay resultados en esta página (hay 25 en total).")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Ir a la primera página" }));

    await screen.findByRole("table", { name: "Empleados" });
    expect(urlParams(router)).toEqual({ role: "MANAGER" });
    expect(queries.at(-1)?.get("page")).toBe("1");
    expect(queries.at(-1)?.get("role")).toBe("MANAGER");
  });

  it("falls back to the defaults for a hand-edited URL (unknown role/status, page 0 or negative)", async () => {
    mockSession(buildUser("HR"));
    mockDepartments();
    const queries = mockList();
    renderApp(`${LIST}?role=ADMIN&status=deleted&page=-3`);

    await screen.findByRole("table", { name: "Empleados" });
    expect(screen.getByLabelText("Rol")).toHaveValue("");
    expect(screen.getByLabelText("Estado")).toHaveValue("active");
    expect(Object.fromEntries(queries[0])).toEqual({ status: "active", page: "1" });
  });

  it("reads every filter from the URL (search box, selects and the API query)", async () => {
    mockSession(buildUser("HR"));
    mockDepartments();
    const queries = mockList((params) => page([LAURA], { page: Number(params.get("page")), total: 41, totalPages: 3 }));
    renderApp(`${LIST}?q=lau&departmentId=dep-1&role=EMPLOYEE&status=all&page=2`);

    await screen.findByRole("table", { name: "Empleados" });
    await waitFor(() => expect(screen.getByLabelText("Departamento")).toHaveValue("dep-1"));
    expect(search()).toHaveValue("lau");
    expect(screen.getByLabelText("Rol")).toHaveValue("EMPLOYEE");
    expect(screen.getByLabelText("Estado")).toHaveValue("all");
    expect(Object.fromEntries(queries[0])).toEqual({
      q: "lau",
      departmentId: "dep-1",
      role: "EMPLOYEE",
      status: "all",
      page: "2",
    });
    expect(summary()).toHaveTextContent("Mostrando 21–21 de 41 empleados.");
  });

  describe("search box", () => {
    it("waits 300 ms after the last keystroke, asks once and REPLACES the history entry, back on page 1", async () => {
      mockSession(buildUser("HR"));
      const queries = mockList();
      const { router } = renderApp(`${LIST}?page=2&role=HR`);
      await screen.findByRole("table", { name: "Empleados" });
      const before = queries.length;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (const text of ["l", "la", "lau"]) {
        fireEvent.change(search(), { target: { value: text } });
        act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50));
      }
      // Still typing: neither the URL nor the API saw it yet.
      expect(router.state.location.search).toBe("?page=2&role=HR");
      expect(queries).toHaveLength(before);

      act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
      act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 10));
      vi.useRealTimers();

      await waitFor(() => expect(queries.at(-1)?.get("q")).toBe("lau"));
      expect(urlParams(router)).toEqual({ q: "lau", role: "HR" });
      expect(router.state.historyAction).toBe("REPLACE");
      expect(queries.slice(before).map((params) => params.get("q"))).toEqual(["lau"]);
      expect(queries.at(-1)?.get("page")).toBe("1");
    });

    it("trims the text and removes q from the URL when it is cleared", async () => {
      mockSession(buildUser("HR"));
      const queries = mockList();
      const { router } = renderApp(`${LIST}?q=ana`);
      await screen.findByRole("table", { name: "Empleados" });
      expect(search()).toHaveValue("ana");

      fireEvent.change(search(), { target: { value: "  omar  " } });
      await waitFor(() => expect(urlParams(router)).toEqual({ q: "omar" }));
      await waitFor(() => expect(queries.at(-1)?.get("q")).toBe("omar"));

      fireEvent.change(search(), { target: { value: "   " } });
      await waitFor(() => expect(router.state.location.search).toBe(""));
      await waitFor(() => expect(queries.at(-1)?.has("q")).toBe(false));
    });

    it("shows 'Buscando…' with the previous results while the new search loads", async () => {
      mockSession(buildUser("HR"));
      const gate = deferred();
      server.use(
        http.get("/api/hr/employees", async ({ request }) => {
          if (new URL(request.url).searchParams.get("q") === "omar") {
            await gate.promise;
            return HttpResponse.json(page([OMAR]));
          }
          return HttpResponse.json(page([LAURA]));
        }),
      );
      renderApp(LIST);
      await screen.findByRole("table", { name: "Empleados" });

      fireEvent.change(search(), { target: { value: "omar" } });
      await waitFor(() => expect(summary()).toHaveTextContent("Buscando…"));
      expect(screen.getByRole("table", { name: "Empleados" })).toHaveTextContent("Laura");
      gate.resolve();
      await waitFor(() => expect(screen.getByRole("table", { name: "Empleados" })).toHaveTextContent("Omar"));
      expect(summary()).toHaveTextContent("1 empleado.");
    });
  });

  describe("selects", () => {
    it("PUSH a new history entry and go back to page 1; the browser's back restores the previous page", async () => {
      mockSession(buildUser("HR"));
      mockDepartments();
      const queries = mockList((params) => page([LAURA], { page: Number(params.get("page")), total: 60, totalPages: 3 }));
      const { user, router } = renderApp(`${LIST}?page=3`);
      await screen.findByRole("table", { name: "Empleados" });

      await user.selectOptions(screen.getByLabelText("Rol"), "MANAGER");
      await waitFor(() => expect(urlParams(router)).toEqual({ role: "MANAGER" }));
      expect(router.state.historyAction).toBe("PUSH");
      await waitFor(() => expect(queries.at(-1)?.get("page")).toBe("1"));

      await user.selectOptions(screen.getByLabelText("Estado"), "inactive");
      await waitFor(() => expect(urlParams(router)).toEqual({ role: "MANAGER", status: "inactive" }));
      await user.selectOptions(screen.getByLabelText("Departamento"), "dep-2");
      await waitFor(() => expect(urlParams(router)).toEqual({ role: "MANAGER", status: "inactive", departmentId: "dep-2" }));

      await act(() => router.navigate(-1));
      expect(urlParams(router)).toEqual({ role: "MANAGER", status: "inactive" });
      expect(screen.getByLabelText("Departamento")).toHaveValue("");
      await act(() => router.navigate(-1));
      await act(() => router.navigate(-1));
      expect(urlParams(router)).toEqual({ page: "3" });
      expect(screen.getByLabelText("Rol")).toHaveValue("");
      expect(screen.getByLabelText("Estado")).toHaveValue("active");
      await waitFor(() => expect(screen.getByText("Página 3 de 3")).toBeInTheDocument());
    });

    it("'Activos' is the default: choosing it again removes status from the URL", async () => {
      mockSession(buildUser("HR"));
      mockList();
      const { user, router } = renderApp(`${LIST}?status=all`);
      await screen.findByRole("table", { name: "Empleados" });

      await user.selectOptions(screen.getByLabelText("Estado"), "active");
      await waitFor(() => expect(router.state.location.search).toBe(""));
    });
  });

  it("back button restores the search TEXT too (search, filter, new search, back)", async () => {
    mockSession(buildUser("HR"));
    mockList();
    const { user, router } = renderApp(LIST);
    await screen.findByRole("table", { name: "Empleados" });

    fireEvent.change(search(), { target: { value: "ana" } });
    await waitFor(() => expect(urlParams(router)).toEqual({ q: "ana" }));
    await user.selectOptions(screen.getByLabelText("Rol"), "MANAGER");
    await waitFor(() => expect(urlParams(router)).toEqual({ q: "ana", role: "MANAGER" }));
    fireEvent.change(search(), { target: { value: "beto" } });
    await waitFor(() => expect(urlParams(router)).toEqual({ q: "beto", role: "MANAGER" }));

    // The search replaced its entry, so back goes to the entry before the select.
    await act(() => router.navigate(-1));
    expect(urlParams(router)).toEqual({ q: "ana" });
    await waitFor(() => expect(search()).toHaveValue("ana"));
    expect(screen.getByLabelText("Rol")).toHaveValue("");

    await act(() => router.navigate(1));
    await waitFor(() => expect(search()).toHaveValue("beto"));
    expect(screen.getByLabelText("Rol")).toHaveValue("MANAGER");

    // Long after the debounce, the restored text must not be written back.
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 100));
    expect(urlParams(router)).toEqual({ q: "beto", role: "MANAGER" });
  });

  it("paginates with real links (one history entry per page) keeping the filters", async () => {
    mockSession(buildUser("HR"));
    const queries = mockList((params) =>
      page([params.get("page") === "2" ? OMAR : LAURA], { page: Number(params.get("page")), total: 45, totalPages: 3 }),
    );
    const { user, router } = renderApp(`${LIST}?q=a&role=EMPLOYEE`);

    const pagination = await screen.findByRole("navigation", { name: "Paginación de empleados" });
    expect(within(pagination).getByText("Página 1 de 3")).toBeInTheDocument();
    // On page 1 "Anterior" stays mounted (so focus is never lost) but disabled.
    expect(within(pagination).getByRole("link", { name: /Anterior/ })).toHaveAttribute("aria-disabled", "true");
    const next = within(pagination).getByRole("link", { name: /Siguiente/ });
    expect(next).toHaveAttribute("href", `${LIST}?q=a&role=EMPLOYEE&page=2`);

    await user.click(next);
    await waitFor(() => expect(within(pagination).getByText("Página 2 de 3")).toBeInTheDocument());
    expect(router.state.historyAction).toBe("PUSH");
    expect(queries.at(-1)?.get("page")).toBe("2");
    await waitFor(() => expect(screen.getByRole("table", { name: "Empleados" })).toHaveTextContent("Omar"));
    expect(summary()).toHaveTextContent("Mostrando 21–21 de 45 empleados.");
    // Page 1 has no "page" parameter.
    expect(within(pagination).getByRole("link", { name: /Anterior/ })).toHaveAttribute("href", `${LIST}?q=a&role=EMPLOYEE`);

    const nextAgain = within(pagination).getByRole("link", { name: /Siguiente/ });
    await user.click(nextAgain);
    await waitFor(() => expect(within(pagination).getByText("Página 3 de 3")).toBeInTheDocument());
    // The last page: the same "Siguiente" link, now disabled, still has the keyboard focus.
    expect(nextAgain).toHaveAttribute("aria-disabled", "true");
    expect(nextAgain).toHaveFocus();
    // Activating it does nothing (no new history entry).
    const entries = router.state.location.key;
    await user.click(nextAgain);
    expect(router.state.location.key).toBe(entries);

    await act(() => router.navigate(-1));
    await waitFor(() => expect(within(pagination).getByText("Página 2 de 3")).toBeInTheDocument());
    expect(search()).toHaveValue("a");
  });

  it("opens the detail and its 'Volver a Empleados' returns to the list with the same filters and text", async () => {
    mockSession(buildUser("HR"));
    mockDepartments();
    mockList((params) => page([LAURA], { page: Number(params.get("page")), total: 30, totalPages: 2 }));
    mockEmployeeDetail(() => HttpResponse.json({ employee: buildEmployeeDetail() }));
    const { user, router } = renderApp(`${LIST}?q=lau&role=EMPLOYEE&status=all&page=2`);

    const table = await screen.findByRole("table", { name: "Empleados" });
    await user.click(within(table).getByRole("link", { name: "Méndez Ortiz, Laura" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Laura Méndez Ortiz" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/administracion/empleados/emp-1");
    const back = screen.getByRole("link", { name: "Volver a Empleados" });
    expect(back).toHaveAttribute("href", `${LIST}?q=lau&role=EMPLOYEE&status=all&page=2`);

    await user.click(back);
    await screen.findByRole("table", { name: "Empleados" });
    expect(urlParams(router)).toEqual({ q: "lau", role: "EMPLOYEE", status: "all", page: "2" });
    expect(search()).toHaveValue("lau");
    expect(screen.getByLabelText("Rol")).toHaveValue("EMPLOYEE");
    expect(screen.getByLabelText("Estado")).toHaveValue("all");
  });

  it("a detail opened directly (no state) goes back to the plain list", async () => {
    mockSession(buildUser("HR"));
    mockEmployeeDetail(() => HttpResponse.json({ employee: buildEmployeeDetail() }));
    renderApp("/administracion/empleados/emp-1");

    await screen.findByRole("heading", { level: 1, name: "Laura Méndez Ortiz" });
    expect(screen.getByRole("link", { name: "Volver a Empleados" })).toHaveAttribute("href", LIST);
  });
});

describe("EmployeesPage: review fixes", () => {
  it("a failed refresh with data on screen says the list may be old, and 'Reintentar' recovers", async () => {
    mockSession(buildUser("HR"));
    mockDepartments();
    let fail = false;
    server.use(
      http.get("/api/hr/employees", () =>
        fail ? HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 }) : HttpResponse.json(page([LAURA])),
      ),
    );
    const { queryClient, user } = renderApp(LIST);
    await screen.findByRole("table", { name: "Empleados" });
    expect(screen.queryByText("La lista puede estar desactualizada")).not.toBeInTheDocument();

    fail = true;
    await act(() => queryClient.invalidateQueries({ queryKey: ["hr", "employees"] }));
    expect(await screen.findByText("La lista puede estar desactualizada")).toBeInTheDocument();
    // The old rows stay on screen.
    expect(screen.getByRole("table", { name: "Empleados" })).toHaveTextContent("Laura");

    fail = false;
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(screen.queryByText("La lista puede estar desactualizada")).not.toBeInTheDocument());
  });

  it("with ?departmentId= in the URL, the filter never shows 'Todos' while the departments load", async () => {
    mockSession(buildUser("HR"));
    mockList(() => page([LAURA]));
    const gate = deferred();
    server.use(
      http.get("/api/hr/departments", async () => {
        await gate.promise;
        return HttpResponse.json({
          departments: [buildDepartment({ id: "dep-1", name: "Tecnología" }), buildDepartment({ id: "dep-2", name: "Ventas" })],
        });
      }),
    );
    renderApp(`${LIST}?departmentId=dep-2`);
    const select = await screen.findByLabelText("Departamento");
    expect(select).toHaveValue("dep-2");
    expect(within(select).getByRole("option", { name: "Cargando…" })).toBeInTheDocument();

    gate.resolve();
    await waitFor(() => expect(within(select).getByRole("option", { name: "Ventas" })).toBeInTheDocument());
    expect(select).toHaveValue("dep-2");
    expect(within(select).queryByRole("option", { name: "Cargando…" })).not.toBeInTheDocument();
  });

  it("if the departments fail, the filter keeps the URL's department and says the list could not load", async () => {
    mockSession(buildUser("HR"));
    mockList(() => page([LAURA]));
    server.use(http.get("/api/hr/departments", () => HttpResponse.json({ error: "x" }, { status: 500 })));
    renderApp(`${LIST}?departmentId=dep-2`);
    const select = await screen.findByLabelText("Departamento");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "Departamento seleccionado" })).toBeInTheDocument(),
    );
    expect(select).toHaveValue("dep-2");
    expect(select).toHaveAccessibleDescription("No se pudieron cargar los departamentos.");
  });

  it("an out-of-range page or an oversized departmentId in the URL fall back to the defaults (no 400)", async () => {
    mockSession(buildUser("HR"));
    mockDepartments();
    const queries = mockList(() => page([LAURA]));
    renderApp(`${LIST}?page=10001&departmentId=${"x".repeat(65)}`);
    await screen.findByRole("table", { name: "Empleados" });
    const last = queries.at(-1);
    expect(last?.get("page")).toBe("1");
    expect(last?.has("departmentId")).toBe(false);
  });
});
