import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { mockSession } from "@/test/server";
import { buildUser } from "@/test/fixtures";

describe("focus on route change", () => {
  it("does not move focus on the initial load", async () => {
    mockSession(buildUser("EMPLOYEE"));
    renderApp("/saldo");

    const heading = await screen.findByRole("heading", { level: 1, name: "Mi saldo" });
    expect(heading).not.toHaveFocus();
  });

  it("moves focus to the new page's h1 after navigating from the menu", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { user } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });

    const nav = screen.getByRole("navigation", { name: "Principal" });
    await user.click(within(nav).getByRole("link", { name: "Mis solicitudes" }));

    const heading = await screen.findByRole("heading", { level: 1, name: "Mis solicitudes" });
    expect(heading).toHaveFocus();
    // Focusable by code, but not part of the Tab order.
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus to the new page's h1 after navigating from the mobile menu", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { user } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });

    await user.click(screen.getByRole("button", { name: "Abrir menú" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("link", { name: "Mis solicitudes" }));

    const heading = await screen.findByRole("heading", { level: 1, name: "Mis solicitudes" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("returns focus to the menu button when the mobile menu closes without navigating", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { user } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });

    const menuButton = screen.getByRole("button", { name: "Abrir menú" });
    await user.click(menuButton);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(menuButton).toHaveFocus());
  });
});
