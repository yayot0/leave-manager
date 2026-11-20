import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { renderApp } from "@/test/render";
import { mockSession, server } from "@/test/server";
import { deferred } from "@/test/deferred";
import { buildUser } from "@/test/fixtures";
import type { User } from "@/api/types";

const CURRENT = "mi contraseña de antes";
const NEW = "una frase larga que solo yo conozco";

type TestUser = ReturnType<typeof renderApp>["user"];

interface ChangePasswordMock {
  calls: unknown[];
}

/** Mocks POST /api/auth/change-password, recording every body it receives. */
function mockChangePassword(
  respond: (body: unknown) => Response | Promise<Response> = () =>
    HttpResponse.json({ user: buildUser("EMPLOYEE") }),
): ChangePasswordMock {
  const mock: ChangePasswordMock = { calls: [] };
  server.use(
    http.post("/api/auth/change-password", async ({ request }) => {
      const body: unknown = await request.json();
      mock.calls.push(body);
      return respond(body);
    }),
  );
  return mock;
}

function apiError(status: number, code: string, error = "Texto del servidor que la UI no debe mostrar") {
  return HttpResponse.json({ error, code }, { status });
}

async function openAccount(sessionUser: User = buildUser("EMPLOYEE")) {
  mockSession(sessionUser);
  const rendered = renderApp("/mi-cuenta");
  await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });
  return rendered;
}

async function fillForm(
  user: TestUser,
  { current = CURRENT, next = NEW, confirm = next }: { current?: string; next?: string; confirm?: string } = {},
  currentLabel = "Contraseña actual",
) {
  if (current) await user.type(screen.getByLabelText(currentLabel), current);
  if (next) await user.type(screen.getByLabelText("Contraseña nueva"), next);
  if (confirm) await user.type(screen.getByLabelText("Confirma la contraseña nueva"), confirm);
}

function submit(user: TestUser) {
  return user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
}

describe("AccountPage", () => {
  it("shows the user's account data and the password policy", async () => {
    await openAccount(buildUser("MANAGER", { firstName: "Luis", lastName: "Pérez", email: "luis@empresa.com" }));

    expect(screen.getByRole("heading", { level: 2, name: "Tu cuenta" })).toBeInTheDocument();
    expect(screen.getByText("luis@empresa.com")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Cambiar contraseña" })).toBeInTheDocument();
    expect(screen.getByText(/al menos 15 caracteres/)).toBeInTheDocument();
    // The policy describes the new-password field.
    expect(screen.getByLabelText("Contraseña nueva")).toHaveAccessibleDescription(
      expect.stringContaining("al menos 15 caracteres"),
    );
    // A normal session has no "temporary password" notice.
    expect(screen.queryByText("Crea tu propia contraseña para continuar")).not.toBeInTheDocument();
  });

  it("is reachable from the menu for every role", async () => {
    mockSession(buildUser("EMPLOYEE"));
    const { user, router } = renderApp("/saldo");
    await screen.findByRole("heading", { level: 1, name: "Mi saldo" });

    const nav = screen.getByRole("navigation", { name: "Principal" });
    await user.click(within(nav).getByRole("link", { name: "Mi cuenta" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Mi cuenta" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/mi-cuenta");
  });

  describe("successful change", () => {
    it("sends only currentPassword and newPassword, announces success in the status region and clears the fields", async () => {
      const mock = mockChangePassword();
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      expect(await screen.findByText(/Tu contraseña se cambió/)).toBeInTheDocument();
      expect(mock.calls).toEqual([{ currentPassword: CURRENT, newPassword: NEW }]);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Tu contraseña se cambió. Se cerraron tus sesiones en otros dispositivos.",
      );
      expect(screen.getByLabelText("Contraseña actual")).toHaveValue("");
      expect(screen.getByLabelText("Contraseña nueva")).toHaveValue("");
      expect(screen.getByLabelText("Confirma la contraseña nueva")).toHaveValue("");
      // Only a temporary password unlocks the app: no "Ir a Mi saldo" for a normal session.
      expect(screen.queryByRole("link", { name: "Ir a Mi saldo" })).not.toBeInTheDocument();
    });

    it("keeps leading and trailing spaces of the passwords (they are part of the password)", async () => {
      const mock = mockChangePassword();
      const { user } = await openAccount();

      await fillForm(user, { current: " actual ", next: "  frase con espacios en los extremos  " });
      await submit(user);

      await screen.findByText(/Tu contraseña se cambió/);
      expect(mock.calls).toEqual([
        { currentPassword: " actual ", newPassword: "  frase con espacios en los extremos  " },
      ]);
    });

    it("the status region is mounted (empty) before there is any message", async () => {
      await openAccount();

      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });

    it("a new submit clears the previous success message", async () => {
      mockChangePassword();
      const { user } = await openAccount();
      await fillForm(user);
      await submit(user);
      await screen.findByText(/Tu contraseña se cambió/);

      // Empty form: client validation fails, the old success must not stay.
      await submit(user);

      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });
  });

  describe("errors from the API, under their field (by code, never the server text)", () => {
    it("INVALID_CURRENT_PASSWORD: message under 'Contraseña actual', aria-invalid and focus there", async () => {
      mockChangePassword(() => apiError(400, "INVALID_CURRENT_PASSWORD"));
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      const field = screen.getByLabelText("Contraseña actual");
      await waitFor(() => expect(field).toHaveFocus());
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAccessibleDescription("La contraseña actual no es correcta.");
      expect(screen.getByLabelText("Contraseña nueva")).not.toHaveAttribute("aria-invalid");
      expect(screen.queryByText("Texto del servidor que la UI no debe mostrar")).not.toBeInTheDocument();
      // A field error is not a general alert.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      // The fields keep what the user typed, to correct it.
      expect(field).toHaveValue(CURRENT);
    });

    it.each([
      ["PASSWORD_TOO_SHORT", "Usa al menos 15 caracteres. Lo más fácil es una frase de varias palabras."],
      ["PASSWORD_TOO_LONG", "Usa como máximo 128 caracteres."],
      [
        "PASSWORD_TOO_COMMON",
        "Esa contraseña es muy común o sigue un patrón fácil de adivinar. Prueba con una frase tuya.",
      ],
      [
        "PASSWORD_CONTAINS_PERSONAL_INFO",
        "La contraseña no puede incluir tu nombre, tu correo, «Leave Manager» o la palabra «vacaciones». Elige otras palabras.",
      ],
      ["PASSWORD_UNCHANGED", "La contraseña nueva debe ser distinta de la actual."],
    ])("%s: message under 'Contraseña nueva', aria-invalid and focus there", async (code, message) => {
      mockChangePassword(() => apiError(400, code));
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      const field = screen.getByLabelText("Contraseña nueva");
      await waitFor(() => expect(field).toHaveFocus());
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText(message)).toBeInTheDocument();
      // The error comes first in the description, then the policy.
      expect(field).toHaveAccessibleDescription(expect.stringMatching(new RegExp(`^${escapeRegExp(message)}`)));
      expect(screen.getByLabelText("Contraseña actual")).not.toHaveAttribute("aria-invalid");
      expect(screen.queryByText("Texto del servidor que la UI no debe mostrar")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("focuses the field again when the same error comes back on a second attempt", async () => {
      mockChangePassword(() => apiError(400, "INVALID_CURRENT_PASSWORD"));
      const { user } = await openAccount();
      await fillForm(user);
      await submit(user);
      const field = screen.getByLabelText("Contraseña actual");
      await waitFor(() => expect(field).toHaveFocus());

      await submit(user);

      await waitFor(() => expect(field).toHaveFocus());
      expect(field).toHaveAttribute("aria-invalid", "true");
    });
  });

  describe("client validation (no request is sent)", () => {
    it("empty form: marks current and new password, focuses the first one, does not call the API", async () => {
      const mock = mockChangePassword();
      const { user } = await openAccount();

      await submit(user);

      const current = screen.getByLabelText("Contraseña actual");
      expect(current).toHaveFocus();
      expect(current).toHaveAttribute("aria-invalid", "true");
      expect(current).toHaveAccessibleDescription("Escribe tu contraseña actual.");
      expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText("Escribe la contraseña nueva.")).toBeInTheDocument();
      expect(mock.calls).toHaveLength(0);
    });

    it("only the new password missing: focus goes to 'Contraseña nueva'", async () => {
      const mock = mockChangePassword();
      const { user } = await openAccount();

      await fillForm(user, { next: "", confirm: "" });
      await submit(user);

      const field = screen.getByLabelText("Contraseña nueva");
      expect(field).toHaveFocus();
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText("Contraseña actual")).not.toHaveAttribute("aria-invalid");
      expect(mock.calls).toHaveLength(0);
    });

    it("confirmation different from the new password: error and focus on the confirmation", async () => {
      const mock = mockChangePassword();
      const { user } = await openAccount();

      await fillForm(user, { confirm: `${NEW}x` });
      await submit(user);

      const confirm = screen.getByLabelText("Confirma la contraseña nueva");
      expect(confirm).toHaveFocus();
      expect(confirm).toHaveAttribute("aria-invalid", "true");
      expect(confirm).toHaveAccessibleDescription("Las contraseñas no coinciden.");
      expect(mock.calls).toHaveLength(0);
    });

    it("empty confirmation counts as not matching", async () => {
      const mock = mockChangePassword();
      const { user } = await openAccount();

      await fillForm(user, { confirm: "" });
      await submit(user);

      expect(screen.getByLabelText("Confirma la contraseña nueva")).toHaveFocus();
      expect(screen.getByText("Las contraseñas no coinciden.")).toBeInTheDocument();
      expect(mock.calls).toHaveLength(0);
    });

    it("the comparison is exact: a confirmation differing only in case does not match", async () => {
      const mock = mockChangePassword();
      const { user } = await openAccount();

      await fillForm(user, { confirm: NEW.toUpperCase() });
      await submit(user);

      expect(screen.getByText("Las contraseñas no coinciden.")).toBeInTheDocument();
      expect(mock.calls).toHaveLength(0);
    });

    it("a fixed form is sent and its old client errors disappear", async () => {
      const mock = mockChangePassword();
      const { user } = await openAccount();
      await submit(user);
      expect(screen.getByLabelText("Contraseña actual")).toHaveAttribute("aria-invalid", "true");

      await fillForm(user);
      await submit(user);

      await screen.findByText(/Tu contraseña se cambió/);
      expect(mock.calls).toHaveLength(1);
      expect(screen.queryByText("Escribe tu contraseña actual.")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Contraseña actual")).not.toHaveAttribute("aria-invalid");
    });
  });

  describe("general errors (alert, no field marked)", () => {
    it("429: alert 'Demasiados intentos' and no field marked invalid", async () => {
      mockChangePassword(() => apiError(429, "TOO_MANY_ATTEMPTS"));
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Demasiados intentos");
      expect(alert).toHaveTextContent("Espera unos minutos");
      expect(alert).not.toHaveTextContent("Texto del servidor que la UI no debe mostrar");
      expect(screen.getByLabelText("Contraseña actual")).not.toHaveAttribute("aria-invalid");
      expect(screen.getByLabelText("Contraseña nueva")).not.toHaveAttribute("aria-invalid");
    });

    it("429 without TOO_MANY_ATTEMPTS (e.g. a proxy's rate limit) does not blame the user's password", async () => {
      mockChangePassword(() => new HttpResponse(null, { status: 429 }));
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Demasiadas solicitudes");
      expect(alert).not.toHaveTextContent("Escribiste mal");
    });

    it("409 STALE_DATA: only 'Iniciar sesión de nuevo' is left, with focus, and the passwords are cleared", async () => {
      mockChangePassword(() => apiError(409, "STALE_DATA"));
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Tu contraseña cambió desde otra sesión");
      expect(alert).toHaveTextContent("Inicia sesión de nuevo.");
      const loginAgain = screen.getByRole("button", { name: "Iniciar sesión de nuevo" });
      await waitFor(() => expect(loginAgain).toHaveFocus());
      expect(screen.queryByRole("button", { name: "Cambiar contraseña" })).not.toBeInTheDocument();
      for (const label of ["Contraseña actual", "Contraseña nueva", "Confirma la contraseña nueva"]) {
        expect(screen.getByLabelText(label)).toHaveValue("");
        expect(screen.getByLabelText(label)).toBeDisabled();
      }

      await user.click(loginAgain);
      expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    });

    it("network error: alert with the connection message", async () => {
      mockChangePassword(() => HttpResponse.error());
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("No se pudo cambiar la contraseña");
      expect(alert).toHaveTextContent("No se pudo conectar con el servidor");
    });

    it("an unknown code or a 500 shows a generic message, never the server text", async () => {
      mockChangePassword(() => apiError(500, "SOMETHING_ELSE"));
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Ocurrió un error inesperado. Intenta de nuevo.");
      expect(alert).not.toHaveTextContent("Texto del servidor que la UI no debe mostrar");
    });

    it("the alert goes away on the next attempt", async () => {
      let attempt = 0;
      mockChangePassword(() => (++attempt === 1 ? apiError(429, "TOO_MANY_ATTEMPTS") : HttpResponse.json({ user: buildUser("EMPLOYEE") })));
      const { user } = await openAccount();
      await fillForm(user);
      await submit(user);
      await screen.findByRole("alert");

      await submit(user);

      await screen.findByText(/Tu contraseña se cambió/);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("disables the button and shows 'Guardando…' while the request is in flight", async () => {
      const gate = deferred();
      mockChangePassword(async () => {
        await gate.promise;
        return HttpResponse.json({ user: buildUser("EMPLOYEE") });
      });
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);

      const button = await screen.findByRole("button", { name: "Guardando…" });
      expect(button).toBeDisabled();

      gate.resolve();

      expect(await screen.findByRole("button", { name: "Cambiar contraseña" })).toBeEnabled();
      expect(screen.getByRole("status")).toHaveTextContent("Tu contraseña se cambió");
    });

    it("pressing Enter while saving does not send a second request", async () => {
      const gate = deferred();
      const mock = mockChangePassword(async () => {
        await gate.promise;
        return HttpResponse.json({ user: buildUser("EMPLOYEE") });
      });
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);
      await screen.findByRole("button", { name: "Guardando…" });
      await user.type(screen.getByLabelText("Confirma la contraseña nueva"), "{Enter}");

      gate.resolve();
      await screen.findByText(/Tu contraseña se cambió/);
      expect(mock.calls).toHaveLength(1);
    });
  });

  describe("'Mostrar contraseñas'", () => {
    it("switches the three fields between password and text", async () => {
      const { user } = await openAccount();
      const fields = [
        screen.getByLabelText("Contraseña actual"),
        screen.getByLabelText("Contraseña nueva"),
        screen.getByLabelText("Confirma la contraseña nueva"),
      ];
      const toggle = screen.getByRole("checkbox", { name: "Mostrar contraseñas" });

      expect(toggle).not.toBeChecked();
      for (const field of fields) expect(field).toHaveAttribute("type", "password");

      await user.click(toggle);
      expect(toggle).toBeChecked();
      for (const field of fields) expect(field).toHaveAttribute("type", "text");

      await user.click(toggle);
      for (const field of fields) expect(field).toHaveAttribute("type", "password");
    });

    it("keeps the typed values when toggled", async () => {
      const { user } = await openAccount();
      await fillForm(user);

      await user.click(screen.getByRole("checkbox", { name: "Mostrar contraseñas" }));

      expect(screen.getByLabelText("Contraseña actual")).toHaveValue(CURRENT);
      expect(screen.getByLabelText("Contraseña nueva")).toHaveValue(NEW);
    });

    it("the fields have the autocomplete hints for password managers and no spellcheck", async () => {
      await openAccount();

      expect(screen.getByLabelText("Contraseña actual")).toHaveAttribute("autocomplete", "current-password");
      expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute("autocomplete", "new-password");
      expect(screen.getByLabelText("Confirma la contraseña nueva")).toHaveAttribute("autocomplete", "new-password");
      expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute("spellcheck", "false");
    });
  });

  describe("temporary password", () => {
    it("labels the first field 'Contraseña temporal' and shows the fixed notice (not an alert)", async () => {
      await openAccount(buildUser("EMPLOYEE", { mustChangePassword: true }));

      expect(screen.getByLabelText("Contraseña temporal")).toBeInTheDocument();
      expect(screen.queryByLabelText("Contraseña actual")).not.toBeInTheDocument();
      expect(screen.getByText("Crea tu propia contraseña para continuar")).toBeInTheDocument();
      // Static notice: present on arrival, so it is not role="alert".
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("a wrong temporary password is reported under 'Contraseña temporal' with focus there", async () => {
      mockChangePassword(() => apiError(400, "INVALID_CURRENT_PASSWORD"));
      const { user } = await openAccount(buildUser("EMPLOYEE", { mustChangePassword: true }));

      await fillForm(user, {}, "Contraseña temporal");
      await submit(user);

      const field = screen.getByLabelText("Contraseña temporal");
      await waitFor(() => expect(field).toHaveFocus());
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAccessibleDescription("La contraseña temporal no es correcta.");
    });
  });

  describe("after an error or a success", () => {
    it("editing the field with an API error clears its message and aria-invalid", async () => {
      mockChangePassword(() => apiError(400, "PASSWORD_TOO_COMMON"));
      const { user } = await openAccount();

      await fillForm(user);
      await submit(user);
      const field = screen.getByLabelText("Contraseña nueva");
      await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));

      await user.type(field, "x");
      expect(field).not.toHaveAttribute("aria-invalid");
      expect(screen.queryByText(/muy común/)).not.toBeInTheDocument();
    });

    it("editing a field with a client error clears only that field's error", async () => {
      const { user } = await openAccount();

      await submit(user);
      const current = screen.getByLabelText("Contraseña actual");
      await waitFor(() => expect(current).toHaveAttribute("aria-invalid", "true"));
      expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute("aria-invalid", "true");

      await user.type(current, "a");
      expect(current).not.toHaveAttribute("aria-invalid");
      expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute("aria-invalid", "true");
    });

    it("turns 'Mostrar contraseñas' off after a successful change", async () => {
      mockChangePassword();
      const { user } = await openAccount();

      await user.click(screen.getByLabelText("Mostrar contraseñas"));
      await fillForm(user);
      await submit(user);

      await screen.findByText(/Tu contraseña se cambió/);
      expect(screen.getByLabelText("Mostrar contraseñas")).not.toBeChecked();
      expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute("type", "password");
    });

    it("tells password managers which account it is (hidden username field)", async () => {
      const { container } = await openAccount();
      const username = container.querySelector('input[autocomplete="username"]');
      expect(username).toHaveValue("employee@empresa.com");
    });
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

