import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router";
import { CircleAlert, KeyRound, LogIn } from "lucide-react";
import { ApiError } from "@/api/client";
import { useChangePassword, useLogout } from "@/auth/session";
import { useCurrentUser } from "@/auth/current-user";
import { HOME_ROUTE, homeLabel, ROLE_LABELS } from "@/app/navigation";
import { APP_NAME, PageHeading } from "@/components/PageHeading";
import { ActionStatus } from "@/components/admin/ActionStatus";
import { FieldError } from "@/components/admin/CatalogFormDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Field = "currentPassword" | "newPassword" | "confirmPassword";
type FieldErrors = Partial<Record<Field, string>>;

const EMPTY_VALUES: Record<Field, string> = { currentPassword: "", newPassword: "", confirmPassword: "" };

/** Words the API rejects besides the user's own data (see password-policy.ts). */
const FORBIDDEN_WORDS_TEXT = `tu nombre, tu correo, «${APP_NAME}» ni la palabra «vacaciones»`;
const FORBIDDEN_WORDS_ERROR = `La contraseña no puede incluir tu nombre, tu correo, «${APP_NAME}» o la palabra «vacaciones». Elige otras palabras.`;

/**
 * Texts for the API's `code`s (never its message). The rules themselves
 * (length, common passwords, personal data) live in the API; the page only
 * explains them.
 */
function serverFieldError(code: string | undefined, isTemporary: boolean): { field: Field; message: string } | null {
  switch (code) {
    case "INVALID_CURRENT_PASSWORD":
      return {
        field: "currentPassword",
        message: isTemporary ? "La contraseña temporal no es correcta." : "La contraseña actual no es correcta.",
      };
    case "PASSWORD_TOO_SHORT":
      return { field: "newPassword", message: "Usa al menos 15 caracteres. Lo más fácil es una frase de varias palabras." };
    case "PASSWORD_TOO_LONG":
      return { field: "newPassword", message: "Usa como máximo 128 caracteres." };
    case "PASSWORD_TOO_COMMON":
      return {
        field: "newPassword",
        message: "Esa contraseña es muy común o sigue un patrón fácil de adivinar. Prueba con una frase tuya.",
      };
    case "PASSWORD_CONTAINS_PERSONAL_INFO":
      return { field: "newPassword", message: FORBIDDEN_WORDS_ERROR };
    case "PASSWORD_UNCHANGED":
      return { field: "newPassword", message: "La contraseña nueva debe ser distinta de la actual." };
    default:
      return null;
  }
}

interface GeneralError {
  title: string;
  message: string;
}

function generalErrorFor(error: Error): GeneralError {
  if (error instanceof ApiError) {
    // Decided by `code`: a 429 from a proxy or another limiter is not the
    // user's mistake.
    if (error.code === "TOO_MANY_ATTEMPTS") {
      return {
        title: "Demasiados intentos",
        message: "Escribiste mal tu contraseña actual varias veces. Espera unos minutos e intenta de nuevo.",
      };
    }
    if (error.status === 429) {
      return {
        title: "Demasiadas solicitudes",
        message: "Hay demasiadas solicitudes en este momento. Espera unos minutos e intenta de nuevo.",
      };
    }
    if (error.code === "STALE_DATA") {
      return {
        title: "Tu contraseña cambió desde otra sesión",
        message:
          "Se cambió en otra sesión o Recursos Humanos la restableció, así que esta sesión ya no es válida. Inicia sesión de nuevo.",
      };
    }
    if (error.isNetworkError) {
      return { title: "No se pudo cambiar la contraseña", message: error.message };
    }
  }
  return { title: "No se pudo cambiar la contraseña", message: "Ocurrió un error inesperado. Intenta de nuevo." };
}

function validate(currentPassword: string, newPassword: string, confirmPassword: string): FieldErrors {
  const errors: FieldErrors = {};
  if (currentPassword === "") errors.currentPassword = "Escribe tu contraseña actual.";
  if (newPassword === "") errors.newPassword = "Escribe la contraseña nueva.";
  else if (confirmPassword !== newPassword) errors.confirmPassword = "Las contraseñas no coinciden.";
  return errors;
}

const FIELD_ORDER: readonly Field[] = ["currentPassword", "newPassword", "confirmPassword"];

export function AccountPage() {
  const user = useCurrentUser();
  const changePassword = useChangePassword();
  const logout = useLogout();
  const [values, setValues] = useState<Record<Field, string>>(EMPTY_VALUES);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const [showPasswords, setShowPasswords] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [unlockedApp, setUnlockedApp] = useState(false);

  const ids = {
    currentPassword: useId(),
    newPassword: useId(),
    confirmPassword: useId(),
    policy: useId(),
    showPasswords: useId(),
  };
  const refs = {
    currentPassword: useRef<HTMLInputElement>(null),
    newPassword: useRef<HTMLInputElement>(null),
    confirmPassword: useRef<HTMLInputElement>(null),
  };
  const loginAgainRef = useRef<HTMLButtonElement>(null);
  const homeLinkRef = useRef<HTMLAnchorElement>(null);

  const serverError = changePassword.error;
  const fieldFromServer =
    serverError instanceof ApiError ? serverFieldError(serverError.code, user.mustChangePassword) : null;
  const generalError = serverError && !fieldFromServer ? generalErrorFor(serverError) : null;
  // STALE_DATA: this session's token is no longer valid, so retrying can
  // only fail; the only way out is logging in again.
  const sessionInvalid = serverError instanceof ApiError && serverError.code === "STALE_DATA";
  const fieldErrors: FieldErrors = fieldFromServer ? { [fieldFromServer.field]: fieldFromServer.message } : clientErrors;

  // After an API answer: focus the field it is about (its message is read
  // through aria-describedby), or "Iniciar sesión de nuevo" when the session
  // is no longer valid (the typed passwords are dropped, they are useless).
  // Keyed on the error object: one focus per answer.
  useEffect(() => {
    if (fieldFromServer) refs[fieldFromServer.field].current?.focus();
    if (sessionInvalid) {
      setValues(EMPTY_VALUES);
      loginAgainRef.current?.focus();
    }
    // refs are stable; serverError identifies the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverError]);

  // The temporary password was replaced: the whole app just opened, so focus
  // goes to the way into it, next to the success message.
  useEffect(() => {
    if (unlockedApp) homeLinkRef.current?.focus();
  }, [unlockedApp]);

  const setValue = (field: Field, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    // Editing a field clears its error (the message and aria-invalid go
    // together). An API error about this field also releases the mutation,
    // which holds both passwords.
    if (fieldFromServer?.field === field) changePassword.reset();
    if (clientErrors[field]) setClientErrors(({ [field]: _removed, ...rest }) => rest);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (changePassword.isPending || sessionInvalid) return;

    setSuccessMessage(null);
    setUnlockedApp(false);
    changePassword.reset();
    const errors = validate(values.currentPassword, values.newPassword, values.confirmPassword);
    setClientErrors(errors);
    const firstInvalid = FIELD_ORDER.find((field) => errors[field]);
    if (firstInvalid) {
      refs[firstInvalid].current?.focus();
      return;
    }

    const wasTemporary = user.mustChangePassword;
    changePassword.mutate(
      { currentPassword: values.currentPassword, newPassword: values.newPassword },
      {
        onSuccess: () => {
          // Passwords leave memory and the screen: the fields, the mutation
          // (gcTime 0) and the "show passwords" option.
          setValues(EMPTY_VALUES);
          setShowPasswords(false);
          changePassword.reset();
          setUnlockedApp(wasTemporary);
          setSuccessMessage(
            wasTemporary
              ? "Listo: ya tienes tu propia contraseña y puedes usar la aplicación."
              : "Tu contraseña se cambió. Se cerraron tus sesiones en otros dispositivos.",
          );
        },
      },
    );
  };

  const fieldProps = (field: Field, extraDescribedBy?: string) => {
    const error = fieldErrors[field];
    const describedBy = [error ? `${ids[field]}-error` : null, extraDescribedBy].filter(Boolean).join(" ");
    return {
      id: ids[field],
      ref: refs[field],
      type: showPasswords ? "text" : "password",
      value: values[field],
      onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(field, event.target.value),
      disabled: sessionInvalid,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": describedBy || undefined,
      // Password managers and pasting are welcome (NIST); spellcheck would
      // send the text to the browser's dictionary service.
      spellCheck: false,
      autoCapitalize: "none",
      autoCorrect: "off",
    } as const;
  };

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeading title="Mi cuenta" description="Tus datos de acceso y tu contraseña." />

      {user.mustChangePassword ? (
        // Static notice (it is there on arrival): role={undefined}, not "alert".
        <Alert role={undefined}>
          <KeyRound aria-hidden="true" />
          <AlertTitle>Crea tu propia contraseña para continuar</AlertTitle>
          <AlertDescription>
            Recursos Humanos te asignó una contraseña temporal. Por seguridad, no puedes usar la aplicación hasta que
            la cambies por una que solo tú conozcas.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Tu cuenta</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
            <dt className="text-muted-foreground">Nombre</dt>
            <dd className="font-medium">
              {user.firstName} {user.lastName}
            </dd>
            <dt className="text-muted-foreground">Correo</dt>
            <dd className="font-medium break-all">{user.email}</dd>
            <dt className="text-muted-foreground">Rol</dt>
            <dd className="font-medium">{ROLE_LABELS[user.role]}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Cambiar contraseña</h2>
          </CardTitle>
          <CardDescription>Al cambiarla se cierran tus sesiones en otros dispositivos.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div id={ids.policy} className="rounded-lg border bg-muted/40 p-4 text-sm">
            <p className="font-medium">Cómo elegir una buena contraseña</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                Usa <strong className="text-foreground">al menos 15 caracteres</strong>. Lo más fácil es una frase de
                varias palabras que solo tú entiendas.
              </li>
              <li>No necesitas mayúsculas, números ni símbolos. Puedes usar espacios y acentos.</li>
              <li>
                Se rechazan las contraseñas muy conocidas o que aparecieron en robos de datos en internet, y los
                patrones fáciles como «aaaaaaaaaaaaaaa» o «123456789012345».
              </li>
              <li>No uses {FORBIDDEN_WORDS_TEXT}.</li>
            </ul>
          </div>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            {/* Tells password managers which account this new password is for. */}
            <input type="text" name="username" autoComplete="username" value={user.email} readOnly hidden />

            <div className="space-y-2">
              <Label htmlFor={ids.currentPassword}>
                {user.mustChangePassword ? "Contraseña temporal" : "Contraseña actual"}
              </Label>
              <Input {...fieldProps("currentPassword")} name="current-password" autoComplete="current-password" />
              <FieldError id={`${ids.currentPassword}-error`} message={fieldErrors.currentPassword ?? null} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={ids.newPassword}>Contraseña nueva</Label>
              <Input {...fieldProps("newPassword", ids.policy)} name="new-password" autoComplete="new-password" />
              <FieldError id={`${ids.newPassword}-error`} message={fieldErrors.newPassword ?? null} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={ids.confirmPassword}>Confirma la contraseña nueva</Label>
              <Input {...fieldProps("confirmPassword")} name="confirm-password" autoComplete="new-password" />
              <FieldError id={`${ids.confirmPassword}-error`} message={fieldErrors.confirmPassword ?? null} />
            </div>

            <div className="flex items-center gap-2">
              <input
                id={ids.showPasswords}
                type="checkbox"
                className="size-4 accent-primary"
                checked={showPasswords}
                disabled={sessionInvalid}
                onChange={(event) => setShowPasswords(event.target.checked)}
              />
              <Label htmlFor={ids.showPasswords} className="font-normal">
                Mostrar contraseñas
              </Label>
            </div>

            {generalError ? (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>{generalError.title}</AlertTitle>
                <AlertDescription>{generalError.message}</AlertDescription>
              </Alert>
            ) : null}

            {sessionInvalid ? (
              <Button
                ref={loginAgainRef}
                type="button"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
              >
                <LogIn aria-hidden="true" />
                {logout.isPending ? "Cerrando sesión…" : "Iniciar sesión de nuevo"}
              </Button>
            ) : (
              <Button type="submit" disabled={changePassword.isPending}>
                {changePassword.isPending ? "Guardando…" : "Cambiar contraseña"}
              </Button>
            )}

            {/* Next to the button, where focus is after submitting. */}
            <ActionStatus message={successMessage} />
            {successMessage && unlockedApp ? (
              <p className="text-sm">
                <Link ref={homeLinkRef} to={HOME_ROUTE} className="font-medium underline underline-offset-4">
                  Ir a {homeLabel()}
                </Link>
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
