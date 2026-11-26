import { useEffect, useRef, type FormEvent, type ReactNode, type RefObject } from "react";
import { CircleAlert } from "lucide-react";
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

interface CatalogFormDialogProps {
  /** From useEntityDialog: the dialog lives at page level, outside the rows. */
  open: boolean;
  setOpen: (open: boolean) => void;
  finalFocus: () => HTMLElement | boolean;
  title: string;
  description?: ReactNode;
  /** The form fields. */
  children: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  isPending: boolean;
  /** Submitting again cannot succeed (e.g. STALE_DATA, or it no longer exists): only "Volver". */
  locked?: boolean;
  /** An error that is not about one field (shown in an alert). */
  generalError: { title: string; message: string } | null;
  /**
   * The mutation's error object, so the SAME general error arriving again
   * (a second failed submit) still moves focus. Optional: without it, a new
   * message is what triggers it.
   */
  errorSignal?: unknown;
  /** Validates and submits; `close` closes the dialog after success. */
  onSubmit: (close: () => void) => void;
  /** First field, focused when the dialog opens. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Id of extra text the submit button should be described by (e.g. the impact). */
  submitDescribedBy?: string;
  /**
   * Shown INSTEAD of the form, in the same dialog (e.g. the temporary
   * password after creating an employee): one dialog, so focus never has to
   * jump between two of them. Built with the Dialog parts (DialogTitle…).
   */
  replaceWith?: ReactNode;
  /** Called once the dialog finished closing (e.g. to forget a secret it showed). */
  onClosed?: () => void;
}

/**
 * Create/edit dialog shared by the HR catalogs: a real <form> (Enter
 * submits), field errors are rendered by the caller next to each field, a
 * general error stays inside the dialog, and it cannot close while saving.
 * Rendered once per page (see useEntityDialog), never inside a list row.
 */
export function CatalogFormDialog({
  open,
  setOpen,
  finalFocus,
  title,
  description,
  children,
  submitLabel,
  pendingLabel,
  isPending,
  locked = false,
  generalError,
  onSubmit,
  initialFocus,
  submitDescribedBy,
  replaceWith,
  onClosed,
  errorSignal,
}: CatalogFormDialogProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const generalMessage = generalError ? `${generalError.title}: ${generalError.message}` : null;
  // A general error: every field and the submit button were disabled while
  // sending (the browser drops focus from a disabled element), and with
  // `locked` the submit button is gone. Nobody else moves focus, so it goes
  // to "Volver", the way out (field errors focus their field instead).
  // After the re-render that re-enables it, as in ConfirmActionDialog.
  useEffect(() => {
    if (generalMessage !== null) backRef.current?.focus();
  }, [generalMessage, errorSignal]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isPending || locked) return;
    onSubmit(() => setOpen(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isPending) return;
        setOpen(nextOpen);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClosed?.();
      }}
      // A click outside must not throw away what replaced the form (a password shown once).
      disablePointerDismissal={replaceWith !== undefined}
    >
      <DialogContent finalFocus={finalFocus} initialFocus={initialFocus} showCloseButton={!isPending}>
        {replaceWith !== undefined ? (
          <div className="grid gap-4">{replaceWith}</div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : null}
            </DialogHeader>

            {children}

            {generalError ? (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>{generalError.title}</AlertTitle>
                <AlertDescription>{generalError.message}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <DialogClose ref={backRef} render={<Button type="button" variant="outline" disabled={isPending} />}>
                Volver
              </DialogClose>
              {locked ? null : (
                <Button type="submit" disabled={isPending} aria-describedby={submitDescribedBy}>
                  {isPending ? pendingLabel : submitLabel}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function FieldError({ id, message }: { id: string; message: string | null }) {
  return message ? (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}
