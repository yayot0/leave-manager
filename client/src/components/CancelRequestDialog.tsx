import { useId, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import type { LeaveRequest, LeaveRequestDetail } from "@/api/types";
import { useCancelLeaveRequest } from "@/hooks/leave-requests";
import { formatDateRange, formatShortDate } from "@/lib/dates";
import { formatBusinessDays } from "@/lib/numbers";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const NOTE_MAX_LENGTH = 500;

type CancellableRequest = Pick<
  LeaveRequest | LeaveRequestDetail,
  "id" | "status" | "startDate" | "endDate" | "businessDays" | "leaveType"
>;

interface CancelRequestDialogProps {
  request: CancellableRequest;
  /** `permissions.canCancel` from the API: whether to offer the button at all. */
  canCancel: boolean;
  /** Visual size of the trigger button. */
  size?: "sm" | "default";
}

function cancelErrorMessage(error: Error): { title: string; message: string } {
  if (error instanceof ApiError && error.status === 409) {
    // Own text only: the API's ("…vuelve a cargarla") would contradict the
    // automatic refresh that already happened behind the dialog.
    return {
      title: "La solicitud cambió de estado",
      message: "Mientras tenías esto abierto, su estado cambió y ya no se puede cancelar. Cierra este aviso para ver cómo quedó.",
    };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { title: "No encontramos esta solicitud", message: "Es posible que ya no exista." };
  }
  return { title: "No se pudo cancelar", message: error.message };
}

/**
 * "Cancelar" button plus its confirmation dialog. The button shows only when
 * the API says `canCancel` (this component never re-implements the state
 * machine), but the dialog stays mounted while it is open or closing, even
 * if `canCancel` turns false meanwhile (success, or a 409 refresh). That way
 * the mutation's callbacks still run, an error stays readable, and focus is
 * moved on purpose instead of falling to <body>.
 */
export function CancelRequestDialog({ request, canCancel, size = "default" }: CancelRequestDialogProps) {
  const [open, setOpen] = useState(false);
  // True from opening until the close animation has finished.
  const [active, setActive] = useState(false);
  const [note, setNote] = useState("");
  const cancel = useCancelLeaveRequest();
  // After a successful cancel the trigger disappears (canCancel turns false),
  // so focus goes to the page's heading instead of being lost.
  const cancelled = useRef(false);
  const noteId = useId();
  const noteHintId = useId();

  const range = formatDateRange(request.startDate, request.endDate, formatShortDate);
  const returnsDays = request.leaveType.countsAgainstVacationBalance;

  const handleOpenChange = (nextOpen: boolean) => {
    // A pending cancellation must finish before closing (it may still fail).
    if (!nextOpen && cancel.isPending) {
      return;
    }
    if (nextOpen) {
      setNote("");
      cancel.reset();
      cancelled.current = false;
      setActive(true);
    }
    setOpen(nextOpen);
  };

  // Back to the trigger as usual, unless it is gone (cancelled, or a refresh
  // removed it): then the page's heading.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const finalFocus = (): HTMLElement | boolean => {
    const triggerGone = cancelled.current || !triggerRef.current?.isConnected;
    return (triggerGone && document.querySelector<HTMLElement>("#main h1")) || true;
  };

  const handleConfirm = () => {
    if (cancel.isPending) {
      return;
    }
    cancel.mutate(
      { id: request.id, note: note.trim() || undefined },
      {
        onSuccess: () => {
          cancelled.current = true;
          setOpen(false);
        },
      },
    );
  };

  const error = cancel.isError ? cancelErrorMessage(cancel.error) : null;

  if (!canCancel && !active) {
    return null;
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setActive(false);
      }}
    >
      {canCancel ? (
        <AlertDialogTrigger
          render={
            <Button
              ref={triggerRef}
              variant="outline"
              size={size}
              // Several "Cancelar" buttons can share a page (the list): the
              // accessible name says which request each one cancels.
              aria-label={`Cancelar solicitud de ${request.leaveType.name}, ${range}`}
            />
          }
        >
          Cancelar
        </AlertDialogTrigger>
      ) : null}
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Cancelar esta solicitud?</AlertDialogTitle>
          <AlertDialogDescription>
            {request.leaveType.name}, {range} ({formatBusinessDays(request.businessDays)}).{" "}
            {returnsDays
              ? request.status === "APPROVED"
                ? "Los días volverán a tu saldo."
                : "Los días que tenía apartados volverán a tu saldo."
              : null}{" "}
            Esta acción no se puede deshacer.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor={noteId}>Motivo de la cancelación (opcional)</Label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={NOTE_MAX_LENGTH}
            aria-describedby={noteHintId}
            disabled={cancel.isPending}
          />
          <p id={noteHintId} className="text-xs text-muted-foreground">
            {note.length}/{NOTE_MAX_LENGTH} caracteres
          </p>
        </div>

        {error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{error.title}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={cancel.isPending}>Volver</AlertDialogCancel>
          <Button variant="destructive" onClick={handleConfirm} disabled={cancel.isPending}>
            {cancel.isPending ? "Cancelando…" : "Sí, cancelar solicitud"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
