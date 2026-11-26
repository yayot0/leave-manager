import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { TemporaryPasswordPanel } from "@/components/admin/employees/TemporaryPasswordPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EntityDialog } from "@/hooks/use-entity-dialog";

interface PasswordAction {
  isPending: boolean;
  error: Error | null;
  /** Runs the action; `onSuccess` receives the temporary password. */
  run: (onSuccess: (temporaryPassword: string) => void) => void;
}

/** 404/409: the employee changed meanwhile, confirming again can never succeed. */
function isConflict(error: Error | null): boolean {
  return error instanceof ApiError && [404, 409].includes(error.status);
}

function errorText(error: Error): { title: string; message: string } {
  if (error instanceof ApiError && error.code === "STALE_DATA") {
    return {
      title: "Alguien más lo cambió",
      message: "Otra persona modificó a este empleado mientras tanto. Cierra este aviso para ver lo actual.",
    };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { title: "Ya no existe", message: "Este empleado ya no existe. Cierra este aviso para ver la lista." };
  }
  return { title: "No se pudo completar", message: error.message };
}

/**
 * Confirmation of an action that produces a temporary password (reset,
 * reactivate). On success the SAME dialog shows the password once
 * (TemporaryPasswordPanel); it is forgotten when the dialog finishes
 * closing. Mounted once per opening (`key={session}`), at page level.
 *
 * `acknowledgement`: a checkbox the user must tick before confirming (the
 * stronger warning for MANAGER/HR accounts).
 */
export function PasswordActionDialog({
  dialog,
  title,
  description,
  children,
  acknowledgement,
  confirmLabel,
  pendingLabel,
  destructive = false,
  revealTitle,
  personName,
  action,
  onDone,
}: {
  dialog: Pick<EntityDialog<unknown>, "open" | "setOpen" | "finalFocus">;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  acknowledgement?: string;
  confirmLabel: string;
  pendingLabel: string;
  /** Red confirm button (restablecer); reactivating is not destructive. */
  destructive?: boolean;
  revealTitle: string;
  personName: string;
  action: PasswordAction;
  onDone: () => void;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const ackId = useId();
  const ackHintId = useId();
  const blocked = acknowledgement !== undefined && !acknowledged;
  const locked = action.isPending || isConflict(action.error);
  const error = action.error ? errorText(action.error) : null;

  // After the re-render that re-enables "Volver" (see ConfirmActionDialog).
  useEffect(() => {
    if (action.error) backRef.current?.focus();
  }, [action.error]);

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && action.isPending) return;
        dialog.setOpen(nextOpen);
      }}
      onOpenChangeComplete={(nextOpen) => {
        // Forget the password once the dialog is gone.
        if (!nextOpen) setPassword(null);
      }}
      // A click outside must not throw away a password shown once.
      disablePointerDismissal
    >
      <DialogContent finalFocus={dialog.finalFocus} showCloseButton={!action.isPending}>
        <div className="grid gap-4">
          {password !== null ? (
            <TemporaryPasswordPanel title={revealTitle} password={password} personName={personName} />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
              </DialogHeader>
              {children}
              {acknowledgement !== undefined ? (
                <div className="flex items-start gap-2">
                  <input
                    id={ackId}
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={acknowledged}
                    disabled={locked}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <div className="space-y-0.5">
                    <label htmlFor={ackId} className="text-sm">
                      {acknowledgement}
                    </label>
                    {blocked ? (
                      <p id={ackHintId} className="text-xs text-muted-foreground">
                        Marca la casilla para continuar.
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {error ? (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>{error.title}</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <DialogClose ref={backRef} render={<Button type="button" variant="outline" disabled={action.isPending} />}>
                  Volver
                </DialogClose>
                {isConflict(action.error) ? null : (
                  <Button
                    type="button"
                    variant={destructive ? "destructive" : "default"}
                    disabled={locked || blocked}
                    // Why it is disabled, read when reaching it.
                    aria-describedby={blocked ? ackHintId : undefined}
                    onClick={() => {
                      if (locked || blocked) return;
                      action.run((temporaryPassword) => {
                        setPassword(temporaryPassword);
                        onDone();
                      });
                    }}
                  >
                    {action.isPending ? pendingLabel : confirmLabel}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
