import { useEffect, useId, useRef, useState } from "react";
import { Copy, KeyRound, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CopyState = "idle" | "copied" | "failed";

/**
 * The temporary password, shown ONCE inside the dialog that produced it
 * (create, reactivate, reset). It lives only in that dialog's state: never
 * in a query, never in storage, and the dialog forgets it when it finishes
 * closing. The API will never return it again.
 */
export function TemporaryPasswordPanel({
  title,
  password,
  personName,
}: {
  title: string;
  password: string;
  /** Who it must be handed to. */
  personName: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<CopyState>("idle");
  const ids = { input: useId(), warning: useId() };

  // The panel replaces the form in an open dialog (initialFocus already ran):
  // move focus to the password, so it is read out with its label.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Entrégala solo a {personName}. Al iniciar sesión tendrá que cambiarla por una propia.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor={ids.input} className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden="true" />
          Contraseña temporal
        </Label>
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            id={ids.input}
            value={password}
            readOnly
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-describedby={ids.warning}
          />
          <Button type="button" variant="outline" onClick={() => void copyToClipboard()}>
            <Copy aria-hidden="true" />
            Copiar
          </Button>
        </div>
        {/* Always mounted, so the result of copying is announced. */}
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {copy === "copied"
            ? "Contraseña copiada."
            : copy === "failed"
              ? "No se pudo copiar automáticamente: selecciónala y cópiala a mano."
              : ""}
        </p>
      </div>

      {/* A fixed notice (not the result of an action): role={undefined}. */}
      <Alert role={undefined} id={ids.warning}>
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>No se volverá a mostrar</AlertTitle>
        <AlertDescription>
          Cópiala ahora y entrégala en persona o por un canal privado. Si se pierde, tendrás que restablecerla de nuevo.
        </AlertDescription>
      </Alert>

      <DialogFooter>
        <DialogClose render={<Button type="button" />}>Listo, ya la copié</DialogClose>
      </DialogFooter>
    </>
  );
}
