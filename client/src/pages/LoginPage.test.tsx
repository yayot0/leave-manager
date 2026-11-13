import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { delay } from "msw/utils/delay";
import { renderApp } from "@/test/render";
import { server } from "@/test/server";
import { VALID_PASSWORD } from "@/test/fixtures";

async function fillAndSubmit(user: ReturnType<typeof renderApp>["user"], password = VALID_PASSWORD) {
  await user.type(await screen.findByLabelText("Correo electrónico"), "ana@empresa.com");
  await user.type(screen.getByLabelText("Contraseña"), password);
  await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));
}

describe("LoginPage", () => {
  it("labels both fields with the right input types", async () => {
    renderApp("/login");

    expect(await screen.findByRole("heading", { level: 1, name: "Iniciar sesión" })).toBeInTheDocument();
    expect(screen.getByLabelText("Correo electrónico")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("type", "password");
  });

  it("logs in and goes to the home page", async () => {
    const { user, router } = renderApp("/login");

    await fillAndSubmit(user);

    expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/saldo");
  });

  it("sends the trimmed email and the password to the API", async () => {
    let received: unknown;
    server.use(
      http.post("/api/auth/login", async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
      }),
    );
    const { user } = renderApp("/login");

    await user.type(await screen.findByLabelText("Correo electrónico"), "  ana@empresa.com ");
    await user.type(screen.getByLabelText("Contraseña"), "secreta");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    await screen.findByRole("alert");
    expect(received).toEqual({ email: "ana@empresa.com", password: "secreta" });
  });

  it("shows a clear message on invalid credentials and stays on login", async () => {
    const { user, router } = renderApp("/login");

    await fillAndSubmit(user, "incorrecta");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Correo o contraseña incorrectos.");
    expect(router.state.location.pathname).toBe("/login");

    // Both fields are marked invalid and point to the message.
    for (const field of [screen.getByLabelText("Correo electrónico"), screen.getByLabelText("Contraseña")]) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAccessibleDescription("Correo o contraseña incorrectos.");
    }
  });

  it("shows the API message when there are too many attempts", async () => {
    server.use(
      http.post("/api/auth/login", () =>
        HttpResponse.json({ error: "Demasiados intentos. Intenta de nuevo más tarde." }, { status: 429 }),
      ),
    );
    const { user } = renderApp("/login");

    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("Demasiados intentos. Intenta de nuevo más tarde.");
    // Not the fields' fault: they are not marked invalid.
    expect(screen.getByLabelText("Correo electrónico")).not.toHaveAttribute("aria-invalid");
  });

  it("shows a connection message when the server is unreachable", async () => {
    server.use(http.post("/api/auth/login", () => HttpResponse.error()));
    const { user } = renderApp("/login");

    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo conectar con el servidor");
  });

  it("disables the button while the request is in flight", async () => {
    server.use(
      http.post("/api/auth/login", async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    const { user } = renderApp("/login");

    await fillAndSubmit(user);

    expect(await screen.findByRole("button", { name: "Iniciando sesión…" })).toBeDisabled();
  });

  describe("redirect after login", () => {
    it("returns to the page that required the session", async () => {
      const { user, router } = renderApp({ pathname: "/login", state: { from: "/solicitudes" } });

      await fillAndSubmit(user);

      expect(await screen.findByRole("heading", { level: 1, name: "Mis solicitudes" })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/solicitudes");
    });

    it.each([
      ["a protocol-relative URL", "//sitio-externo.com"],
      ["an absolute URL", "https://sitio-externo.com/login"],
      ["a page the role cannot open", "/aprobaciones"],
    ])("goes home instead of to %s", async (_case, from) => {
      // The default login handler returns an EMPLOYEE.
      const { user, router } = renderApp({ pathname: "/login", state: { from } });

      await fillAndSubmit(user);

      expect(await screen.findByRole("heading", { level: 1, name: "Mi saldo" })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/saldo");
    });
  });
});
