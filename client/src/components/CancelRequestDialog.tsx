import { useId, useState } from "react";
import { CircleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import type { LeaveRequest, LeaveRequestDetail } from "@/api/types";
import { useCancelLeaveRequest } from "@/hooks/leave-requests";
import { useStickyDialog } from "@/hooks/use-sticky-dialog";
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
 * if `canCancel` turns false meanwhile (success, or a 409 refresh): see
 * `useStickyDialog`.
 */
export function CancelRequestDialog({ request, canCancel, size = "default" }: CancelRequestDialogProps) {
  const [note, setNote] = useState("");
  const cancel = useCancelLeaveRequest();
  const { active, triggerRef, finalFocus, closeAfterSuccess, rootProps } = useStickyDialog({
    isBusy: cancel.isPending,
    onOpen: () => {
      setNote("");
      cancel.reset();
    },
  });
  const noteId = useId();
  const noteHintId = useId();

  const range = formatDateRange(request.startDate, request.endDate, formatShortDate);
  const returnsDays = request.leaveType.countsAgainstVacationBalance;

  const handleConfirm = () => {
    if (cancel.isPending) {
      return;
    }
    cancel.mutate({ id: request.id, note: note.trim() || undefined }, { onSuccess: closeAfterSuccess });
  };

  const error = cancel.isError ? cancelErrorMessage(cancel.error) : null;

  if (!canCancel && !active) {
    return null;
  }

  return (
    <AlertDialog {...rootProps}>
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
