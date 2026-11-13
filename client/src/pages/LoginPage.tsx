import { useId, useState, type FormEvent } from "react";
import { CalendarDays, CircleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { useLogin } from "@/auth/session";
import { APP_NAME } from "@/components/PageHeading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function loginErrorMessage(error: Error): string {
  if (!(error instanceof ApiError)) {
    return "Ocurrió un error inesperado. Intenta de nuevo.";
  }
  if (error.status === 401) {
    return "Correo o contraseña incorrectos.";
  }
  if (error.status === 429) {
    // The API explains the limit ("Demasiados intentos…").
    return error.message;
  }
  if (error.status === 400) {
    return "Revisa que el correo tenga un formato válido y escribe tu contraseña.";
  }
  return error.message;
}

export function LoginPage() {
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errorId = useId();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.isPending) {
      return;
    }
    // On success the session gets the user and PublicOnlyRoute redirects.
    login.mutate({ email: email.trim(), password });
  };

  const errorMessage = login.isError ? loginErrorMessage(login.error) : null;
  // Only 400/401 are about what was typed; 429 or a network error is not
  // the fields' fault. aria-invalid + aria-describedby make a screen reader
  // repeat the error when the user goes back to a field.
  const fieldsInvalid = login.error instanceof ApiError && (login.error.status === 400 || login.error.status === 401);
  const fieldProps = fieldsInvalid ? { "aria-invalid": true, "aria-describedby": errorId } : {};

  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-8">
      <title>{`Iniciar sesión · ${APP_NAME}`}</title>
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2 text-lg font-semibold">
          <CalendarDays className="size-6" aria-hidden="true" />
          <span>{APP_NAME}</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="text-xl font-semibold">Iniciar sesión</h1>
            </CardTitle>
            <CardDescription>Ingresa con tu correo de la empresa.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {errorMessage ? (
                <Alert variant="destructive" id={errorId}>
                  <CircleAlert aria-hidden="true" />
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="email">Correo electrónico</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  required
                  {...fieldProps}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Contraseña</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  {...fieldProps}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
                {login.isPending ? "Iniciando sesión…" : "Iniciar sesión"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
