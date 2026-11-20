import type { FormEvent, ReactNode, RefObject } from "react";
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
  /** Validates and submits; `close` closes the dialog after success. */
  onSubmit: (close: () => void) => void;
  /** First field, focused when the dialog opens. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Id of extra text the submit button should be described by (e.g. the impact). */
  submitDescribedBy?: string;
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
}: CatalogFormDialogProps) {
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
    >
      <DialogContent finalFocus={finalFocus} initialFocus={initialFocus} showCloseButton={!isPending}>
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
            <DialogClose render={<Button type="button" variant="outline" disabled={isPending} />}>Volver</DialogClose>
            {locked ? null : (
              <Button type="submit" disabled={isPending} aria-describedby={submitDescribedBy}>
                {isPending ? pendingLabel : submitLabel}
              </Button>
            )}
          </DialogFooter>
        </form>
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
