import { useEffect, useRef, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** The part of a TanStack mutation this dialog needs (any variables). */
interface ConfirmableAction {
  isPending: boolean;
  error: Error | null;
  /** Runs the action; `onSuccess` closes the dialog. */
  run: (callbacks: { onSuccess: () => void }) => void;
}

interface ConfirmActionDialogProps {
  /** From useEntityDialog: the dialog lives at page level, outside the rows. */
  open: boolean;
  setOpen: (open: boolean) => void;
  finalFocus: () => HTMLElement | boolean;
  title: string;
  description: ReactNode;
  /** Extra content between the description and the error (e.g. impact). */
  children?: ReactNode;
  /** Id of extra text the confirm button should be described by (e.g. the impact). */
  confirmDescribedBy?: string;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  /** false: the action cannot be done; only "Volver" is offered (e.g. a department with employees). */
  canConfirm?: boolean;
  action: ConfirmableAction;
  onDone?: () => void;
  /** The action deletes the entity: focus goes to the h1, not to its (vanishing) row. */
  onRemoved?: () => void;
}

/** 404/409: the data already changed, so confirming again can never succeed. */
function isConflict(error: Error | null): boolean {
  return error instanceof ApiError && [404, 409].includes(error.status);
}

function errorText(error: Error): { title: string; message: string } {
  if (error instanceof ApiError && error.status === 404) {
    return {
      title: "Ya no existe",
      message: "Alguien más lo borró mientras tenías esto abierto. Cierra este aviso para ver la lista actualizada.",
    };
  }
  return { title: "No se pudo completar", message: error.message };
}

/**
 * Confirmation before deactivating, reactivating, deleting or removing a
 * catalog entry. Rendered once per page (see useEntityDialog), so it stays
 * on screen with its error even if the row behind it disappears. It cannot
 * close while the action runs; after a 404/409 only "Volver" is left; after
 * any error focus moves to "Volver" (the focused confirm button was disabled
 * while sending, so focus would otherwise be lost).
 */
export function ConfirmActionDialog({
  open,
  setOpen,
  finalFocus,
  title,
  description,
  children,
  confirmDescribedBy,
  confirmLabel,
  pendingLabel,
  destructive = false,
  canConfirm = true,
  action,
  onDone,
  onRemoved,
}: ConfirmActionDialogProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const locked = action.isPending || isConflict(action.error) || !canConfirm;
  const error = action.error ? errorText(action.error) : null;

  // After the re-render that re-enables "Volver" (a callback would run while
  // it is still disabled, and focus() on a disabled button does nothing).
  useEffect(() => {
    if (action.error) backRef.current?.focus();
  }, [action.error]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && action.isPending) return;
        setOpen(nextOpen);
      }}
    >
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{error.title}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel ref={backRef} disabled={action.isPending}>
            Volver
          </AlertDialogCancel>
          {canConfirm ? (
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled={locked}
              aria-describedby={confirmDescribedBy}
              onClick={() => {
                if (locked) return;
                action.run({
                  onSuccess: () => {
                    onRemoved?.();
                    setOpen(false);
                    onDone?.();
                  },
                });
              }}
            >
              {action.isPending ? pendingLabel : confirmLabel}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
