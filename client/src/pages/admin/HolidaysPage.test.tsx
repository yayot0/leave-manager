import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import type { Holiday, HolidayImpact } from "@/api/types";
import { todayISO } from "@/lib/dates";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildHoliday, buildUser } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

const CURRENT_YEAR = Number(todayISO().slice(0, 4));

const REVOLUCION = buildHoliday({ id: "hol-rev", date: `${CURRENT_YEAR}-11-16`, name: "Revolución" });

const NO_IMPACT: HolidayImpact = {
  affectedRequests: 0,
  breakdown: { countingBalance: 0, notCountingBalance: 0, past: 0, upcoming: 0 },
};

/** 3 requests: 2 count against the balance and 1 does not; 1 already over, 2 running or upcoming. */
const MIXED_IMPACT: HolidayImpact = {
  affectedRequests: 3,
  breakdown: { countingBalance: 2, notCountingBalance: 1, past: 1, upcoming: 2 },
};

/** GET by year; records which years were asked. */
function mockHolidays(byYear: Record<number, Holiday[]>) {
  const years: string[] = [];
  server.use(
    http.get("/api/hr/holidays", ({ request }) => {
      const year = new URL(request.url).searchParams.get("year") ?? "";
      years.push(year);
      return HttpResponse.json({ holidays: byYear[Number(year)] ?? [] });
    }),
  );
  return years;
}

function mockImpact(byDate: Record<string, HolidayImpact>) {
  const asked: string[] = [];
  server.use(
    http.get("/api/hr/holidays/impact", ({ request }) => {
      const date = new URL(request.url).searchParams.get("date") ?? "";
      asked.push(date);
      return HttpResponse.json(byDate[date] ?? NO_IMPACT);
    }),
  );
  return asked;
}

function table() {
  return screen.findByRole("table", { name: "Festivos" });
}

function setDate(dialog: HTMLElement, value: string) {
  // Date inputs take the whole value at once (like the browser picker).
  fireEvent.change(within(dialog).getByLabelText("Fecha"), { target: { value } });
}

describe("HolidaysPage", () => {
  it("lists the current year's holidays with their weekday as table and cards, and changes year", async () => {
    mockSession(buildUser("HR"));
    const years = mockHolidays({ [CURRENT_YEAR]: [REVOLUCION] });
    const { user } = renderApp("/administracion/festivos");

    const row = within(await table()).getAllByRole("row")[1];
    expect(within(row).getByRole("rowheader")).toHaveTextContent(`16 de noviembre de ${CURRENT_YEAR}`);
    expect(row).toHaveTextContent("Revolución");
    const card = within(screen.getByRole("list", { name: "Festivos" })).getByRole("listitem");
    expect(card).toHaveTextContent("Revolución");
    expect(within(card).getByRole("button", { name: /Quitar Revolución/ })).toBeInTheDocument();
    expect(years).toEqual([String(CURRENT_YEAR)]);

    await user.selectOptions(screen.getByLabelText("Año"), String(CURRENT_YEAR + 1));
    expect(await screen.findByRole("heading", { level: 2, name: `No hay festivos en ${CURRENT_YEAR + 1}` })).toBeInTheDocument();
    expect(years).toContain(String(CURRENT_YEAR + 1));
  });

  it("shows a loading state for the chosen year and an error with Reintentar", async () => {
    mockSession(buildUser("HR"));
    const gate = deferred();
    server.use(
      http.get("/api/hr/holidays", async () => {
        await gate.promise;
        return HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 });
      }),
    );
    const { user } = renderApp("/administracion/festivos");

    expect(await screen.findByText(`Cargando festivos de ${CURRENT_YEAR}…`)).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar los festivos");
    mockHolidays({ [CURRENT_YEAR]: [REVOLUCION] });
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await table()).toBeInTheDocument();
  });

  it("adds a holiday, showing the impact breakdown in a live region that describes the submit button", async () => {
    mockSession(buildUser("HR"));
    mockHolidays({ [CURRENT_YEAR + 1]: [] });
    const date = `${CURRENT_YEAR + 1}-02-01`;
    mockImpact({ [date]: MIXED_IMPACT });
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/hr/holidays", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          { holiday: buildHoliday({ date, name: "Constitución" }), ...MIXED_IMPACT },
          { status: 201 },
        );
      }),
    );
    const { user } = renderApp("/administracion/festivos");
    await screen.findByRole("heading", { level: 2, name: `No hay festivos en ${CURRENT_YEAR}` });

    await user.click(screen.getByRole("button", { name: "Agregar festivo" }));
    const dialog = await screen.findByRole("dialog", { name: "Agregar festivo" });
    expect(within(dialog).getByLabelText("Fecha")).toHaveAttribute("min", "2000-01-01");
    setDate(dialog, date);

    const region = within(dialog).getByRole("status");
    expect(await within(region).findByText("3 solicitudes activas cruzan esta fecha")).toBeInTheDocument();
    expect(region).toHaveTextContent("2 descuentan saldo y 1 no; 1 ya terminó y 2 están en curso o por venir.");
    expect(region).toHaveTextContent("seguirán contando ese día como hábil");
    expect(region).toHaveTextContent("pueden necesitar un ajuste");
    // A notice inside a polite live region, not an interrupting alert.
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Agregar" })).toHaveAccessibleDescription(/3 solicitudes activas/);

    await user.type(within(dialog).getByLabelText("Nombre"), "Constitución");
    await user.click(within(dialog).getByRole("button", { name: "Agregar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([{ date, name: "Constitución" }]);
    const status = screen.getAllByRole("status").find((element) => element.textContent?.includes("agregado"));
    expect(status).toHaveTextContent('Festivo "Constitución" agregado');
    expect(status).toHaveTextContent("3 solicitudes activas cruzan esa fecha y no se recalcularon");
    expect(status).toHaveTextContent("corrige el saldo con un ajuste");
    // Jumps to the year where it landed.
    expect(screen.getByLabelText("Año")).toHaveValue(String(CURRENT_YEAR + 1));
  });

  it("asks the impact only once the typed date settles (not for 0002-…, 0020-… while typing the year)", async () => {
    mockSession(buildUser("HR"));
    mockHolidays({});
    const asked = mockImpact({});
    const { user } = renderApp("/administracion/festivos");
    await screen.findByRole("heading", { level: 2, name: /No hay festivos/ });

    await user.click(screen.getByRole("button", { name: "Agregar festivo" }));
    const dialog = await screen.findByRole("dialog");
    for (const partial of ["0002-11-20", "0020-11-20", "0202-11-20", `${CURRENT_YEAR}-11-20`]) {
      setDate(dialog, partial);
    }

    expect(await within(dialog).findByText("Ninguna solicitud activa cambia por este festivo.")).toBeInTheDocument();
    expect(asked).toEqual([`${CURRENT_YEAR}-11-20`]);
  });

  it("explains when the impact cannot be checked", async () => {
    mockSession(buildUser("HR"));
    mockHolidays({});
    server.use(http.get("/api/hr/holidays/impact", () => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 })));
    const { user } = renderApp("/administracion/festivos");
    await screen.findByRole("heading", { level: 2, name: /No hay festivos/ });

    await user.click(screen.getByRole("button", { name: "Agregar festivo" }));
    const dialog = await screen.findByRole("dialog");
    setDate(dialog, `${CURRENT_YEAR}-11-20`);

    expect(await within(dialog).findByText(/No se pudo revisar qué solicitudes cruzan esa fecha/)).toBeInTheDocument();
  });

  it("validates the form, focusing the first invalid field, and focuses the date after DUPLICATE_DATE", async () => {
    mockSession(buildUser("HR"));
    mockHolidays({ [CURRENT_YEAR]: [REVOLUCION] });
    mockImpact({});
    let posts = 0;
    server.use(
      http.post("/api/hr/holidays", () => {
        posts++;
        return HttpResponse.json({ error: "Ya hay un festivo en esa fecha", code: "DUPLICATE_DATE" }, { status: 409 });
      }),
    );
    const { user } = renderApp("/administracion/festivos");
    await table();

    await user.click(screen.getByRole("button", { name: "Agregar festivo" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Agregar" }));
    const date = within(dialog).getByLabelText("Fecha");
    expect(date).toHaveAccessibleDescription("Elige una fecha entre 2000 y 2100.");
    expect(date).toHaveFocus();
    expect(within(dialog).getByLabelText("Nombre")).toHaveAttribute("aria-invalid", "true");
    expect(posts).toBe(0);

    setDate(dialog, REVOLUCION.date);
    await user.type(within(dialog).getByLabelText("Nombre"), "Otra");
    await user.click(within(dialog).getByRole("button", { name: "Agregar" }));

    await waitFor(() => expect(date).toHaveAccessibleDescription("Ya hay un festivo en esa fecha"));
    expect(date).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(date).toHaveFocus());
  });

  it("asks the impact only when the remove dialog opens, then removes the holiday and focuses the h1", async () => {
    mockSession(buildUser("HR"));
    mockHolidays({ [CURRENT_YEAR]: [REVOLUCION] });
    const oneUpcoming: HolidayImpact = {
      affectedRequests: 1,
      breakdown: { countingBalance: 0, notCountingBalance: 1, past: 0, upcoming: 1 },
    };
    const asked = mockImpact({ [REVOLUCION.date]: oneUpcoming });
    let deleted = "";
    server.use(
      http.delete("/api/hr/holidays/:id", ({ params }) => {
        deleted = String(params.id);
        return HttpResponse.json(oneUpcoming);
      }),
    );
    const { user } = renderApp("/administracion/festivos");
    const tableElement = await table();
    expect(asked).toEqual([]);

    await user.click(
      within(tableElement).getByRole("button", { name: `Quitar Revolución, 16 de noviembre de ${CURRENT_YEAR}` }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: "¿Quitar Revolución?" });
    const region = within(dialog).getByRole("status");
    expect(await within(region).findByText("1 solicitud activa cruza esta fecha")).toBeInTheDocument();
    expect(region).toHaveTextContent("0 descuentan saldo y 1 no; 0 ya terminaron y 1 está en curso o por venir.");
    expect(region).toHaveTextContent("Ninguna descuenta saldo: no hace falta ajustar.");
    expect(within(dialog).getByRole("button", { name: "Sí, quitar" })).toHaveAccessibleDescription(/1 solicitud activa/);
    expect(asked).toEqual([REVOLUCION.date]);

    await user.click(within(dialog).getByRole("button", { name: "Sí, quitar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(deleted).toBe("hol-rev");
    expect(screen.getByText(/Festivo "Revolución" quitado\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Festivos" })).toHaveFocus();
  });

  it("keeps the remove dialog and its 404 on screen when the holiday was already removed", async () => {
    mockSession(buildUser("HR"));
    const holidays: Holiday[] = [REVOLUCION];
    server.use(http.get("/api/hr/holidays", () => HttpResponse.json({ holidays: [...holidays] })));
    mockImpact({});
    server.use(
      http.delete("/api/hr/holidays/:id", () => {
        holidays.length = 0;
        return HttpResponse.json({ error: "Festivo no encontrado" }, { status: 404 });
      }),
    );
    const { user } = renderApp("/administracion/festivos");

    await user.click(within(await table()).getByRole("button", { name: /Quitar Revolución/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Sí, quitar" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Ya no existe");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Volver" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Volver" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { level: 2, name: `No hay festivos en ${CURRENT_YEAR}` })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Festivos" })).toHaveFocus();
  });
});
