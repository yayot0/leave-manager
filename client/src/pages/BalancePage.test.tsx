import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { buildBalance, buildUser } from "@/test/fixtures";
import { deferred } from "@/test/deferred";

function mockBalance(overrides: Parameters<typeof buildBalance>[0] = {}) {
  server.use(http.get("/api/me/balance", () => HttpResponse.json({ balance: buildBalance(overrides) })));
}

function breakdownValue(label: string): string {
  const term = screen.getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent ?? "";
}

describe("BalancePage", () => {
  it("shows a loading state while the balance loads", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const gate = deferred();
    server.use(
      http.get("/api/me/balance", async () => {
        await gate.promise;
        return HttpResponse.json({ balance: buildBalance() });
      }),
    );
    renderApp("/saldo");

    expect(await screen.findByText("Cargando tu saldo…")).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByRole("heading", { name: "Días disponibles" })).toBeInTheDocument();
    expect(screen.queryByText("Cargando tu saldo…")).not.toBeInTheDocument();
  });

  it("shows the available days and explains each number of the breakdown", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockBalance({ yearsOfService: 5, earned: 20, adjustments: 2, approved: 5, pending: 3, available: 14 });
    renderApp("/saldo");

    const card = (await screen.findByRole("heading", { name: "Días disponibles" })).closest<HTMLElement>("[data-slot=card]");
    expect(within(card!).getByText("14")).toBeInTheDocument();
    expect(screen.getByText(/5 años de servicio · calculado al 17 de noviembre de 2026/)).toBeInTheDocument();

    expect(breakdownValue("Ganados por antigüedad")).toBe("+20");
    expect(breakdownValue("Ajustes de Recursos Humanos")).toBe("+2");
    expect(breakdownValue("Aprobados")).toBe("−5");
    expect(breakdownValue("Pendientes")).toBe("−3");
    expect(breakdownValue("Disponibles")).toBe("14");
    expect(screen.getByText(/la Ley Federal del Trabajo te da 20 días en este periodo/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedir vacaciones" })).toHaveAttribute("href", "/solicitudes/nueva");
  });

  it("shows the period dates on their own day, even in Monterrey (UTC-6)", async () => {
    mockSession(buildUser("EMPLOYEE"));
    // Formatted naively, "2026-03-01" would read "28 de febrero" in Monterrey.
    mockBalance({ period: { start: "2026-03-01", end: "2027-02-28" } });
    renderApp("/saldo");

    expect(
      await screen.findByText("Periodo del 1 de marzo de 2026 al 28 de febrero de 2027"),
    ).toBeInTheDocument();
  });

  it("explains the first year, when no days are earned yet", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockBalance({
      period: { start: "2026-06-01", end: "2027-05-31" },
      yearsOfService: 0,
      earned: 0,
      adjustments: 0,
      approved: 0,
      pending: 0,
      available: 0,
    });
    renderApp("/saldo");

    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Aún estás en tu primer año");
    expect(note).toHaveTextContent("primer aniversario, el 1 de junio de 2027");
    expect(screen.queryByRole("link", { name: "Pedir vacaciones" })).not.toBeInTheDocument();
  });

  it("warns when an HR adjustment left the balance negative", async () => {
    mockSession(buildUser("EMPLOYEE"));
    mockBalance({ adjustments: -10, available: -2 });
    renderApp("/saldo");

    expect(await screen.findByRole("alert")).toHaveTextContent("Tu saldo está en negativo");
    expect(breakdownValue("Ajustes de Recursos Humanos")).toBe("−10");
  });

  it("shows the error and recovers with Reintentar", async () => {
    mockSession(buildUser("EMPLOYEE"));
    server.use(
      http.get("/api/me/balance", () => HttpResponse.json({ error: "Error interno del servidor" }, { status: 500 })),
    );
    const { user } = renderApp("/saldo");

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar tu saldo");

    mockBalance();
    await user.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByRole("heading", { name: "Días disponibles" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
