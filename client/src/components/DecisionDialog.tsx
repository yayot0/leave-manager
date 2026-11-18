import { useId, useRef, useState, type FormEvent } from "react";
import { CalendarClock, CircleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import type { LeaveRequestDetail } from "@/api/types";
import { isConflictError, useDecideLeaveRequest, type Decision } from "@/hooks/leave-requests";
import { useStickyDialog } from "@/hooks/use-sticky-dialog";
import { formatDate, formatDateRange, formatShortDate } from "@/lib/dates";
import { formatBusinessDays, formatDays } from "@/lib/numbers";
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

export type { Decision };

const TEXTS = {
  approve: {
    trigger: "Aprobar",
    title: "¿Aprobar esta solicitud?",
    noteLabel: "Nota para el empleado (opcional)",
    confirm: "Sí, aprobar",
    pending: "Aprobando…",
    failed: "No se pudo aprobar",
  },
  reject: {
    trigger: "Rechazar",
    title: "¿Rechazar esta solicitud?",
    noteLabel: "Motivo del rechazo (obligatorio)",
    confirm: "Sí, rechazar",
    pending: "Rechazando…",
    failed: "No se pudo rechazar",
  },
} as const;

const REQUIRED_NOTE_MESSAGE = "Escribe el motivo del rechazo: el empleado lo verá en su solicitud.";

/**
 * Own texts for the errors that mean "what you saw is outdated": the data is
 * refreshed behind the dialog (see useRequestActionMutation), so the API's
 * "vuelve a cargarla" would contradict it.
 */
function decisionErrorMessage(error: Error, decision: Decision): { title: string; message: string } {
  // The business reason comes as `code` (CLAUDE.md: never interpret the message).
  if (error instanceof ApiError && error.code === "INSUFFICIENT_BALANCE") {
    return {
      title: "Saldo insuficiente para aprobar",
      message:
        "El saldo de vacaciones del empleado en este periodo ya no alcanza (puede que RH haya hecho un ajuste). Puedes rechazarla o pedir a RH que revise el saldo.",
    };
  }
  if (error instanceof ApiError) {
    switch (error.status) {
      case 409:
        return {
          title: "La solicitud cambió de estado",
          message:
            "Mientras tenías esto abierto, su estado cambió (por ejemplo, el empleado la canceló) y ya no se puede decidir. Cierra este aviso para ver cómo quedó.",
        };
      case 403:
        return {
          title: "No puedes decidir esta solicitud",
          message:
            "Ya no te corresponde decidirla (por ejemplo, el empleado cambió de jefe). Cierra este aviso para ver cómo quedó.",
        };
      case 404:
        return { title: "No encontramos esta solicitud", message: "Es posible que ya no exista o que ya no tengas acceso a ella." };
    }
  }
  return { title: TEXTS[decision].failed, message: error.message };
}

interface DecisionDialogProps {
  decision: Decision;
  request: LeaveRequestDetail;
  /** From the API (`permissions.canApprove`/`canReject`, balance): whether to offer the button. */
  allowed: boolean;
  /** Called after the API confirmed the decision. */
  onDecided?: (decision: Decision) => void;
}

/**
 * "Aprobar" or "Rechazar" button plus its confirmation dialog. Like
 * CancelRequestDialog, it stays mounted while open or closing even if
 * `allowed` turns false (success, or a refresh after 409/403/422), so the
 * error remains readable and focus lands on the page's h1.
 *
 * Rejecting requires a note (the API also enforces it): an empty or
 * whitespace-only note is stopped here with a message on the field.
 */
export function DecisionDialog({ decision, request, allowed, onDecided }: DecisionDialogProps) {
  const texts = TEXTS[decision];
  const isReject = decision === "reject";
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const mutation = useDecideLeaveRequest(decision);
  const { active, triggerRef, finalFocus, closeAfterSuccess, rootProps } = useStickyDialog({
    isBusy: mutation.isPending,
    onOpen: () => {
      setNote("");
      setNoteError(null);
      mutation.reset();
    },
  });
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // After a 409 the decision can no longer be made: only "Volver" is left.
  const conflict = isConflictError(mutation.error);
  const locked = mutation.isPending || conflict;
  const noteId = useId();
  const noteHintId = useId();
  const noteErrorId = useId();

  const requester = `${request.requester.firstName} ${request.requester.lastName}`;
  const range = formatDateRange(request.startDate, request.endDate, formatShortDate);
  const balance = request.requesterBalance;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked) {
      return;
    }
    const trimmed = note.trim();
    const onSuccess = () => {
      closeAfterSuccess();
      onDecided?.(decision);
    };
    if (isReject && !trimmed) {
      setNoteError(REQUIRED_NOTE_MESSAGE);
      noteRef.current?.focus();
      return;
    }
    mutation.mutate(
      { id: request.id, note: trimmed },
      {
        onSuccess,
        // The focused confirm button becomes disabled: move focus to the one way out.
        onError: (mutationError) => {
          if (isConflictError(mutationError)) backRef.current?.focus();
        },
      },
    );
  };

  const error = mutation.isError ? decisionErrorMessage(mutation.error, decision) : null;

  if (!allowed && !active) {
    return null;
  }

  return (
    <AlertDialog {...rootProps}>
      {allowed ? (
        <AlertDialogTrigger
          render={<Button ref={triggerRef} variant={isReject ? "outline" : "default"} />}
        >
          {texts.trigger}
        </AlertDialogTrigger>
      ) : null}
      {/* Rejecting starts on the note, the one thing it needs. */}
      <AlertDialogContent finalFocus={finalFocus} initialFocus={isReject ? noteRef : undefined}>
        <form onSubmit={handleSubmit} noValidate className="grid gap-4">
          <AlertDialogHeader>
            <AlertDialogTitle>{texts.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {request.leaveType.name} de {requester}, {range} ({formatBusinessDays(request.businessDays)}).{" "}
              {balance
                ? isReject
                  ? `Los días apartados volverán a su saldo (quedaría con ${formatDays(balance.availableWithoutRequest)}).`
                  : `Le quedarán ${formatDays(balance.availableAfterApproval)} de vacaciones en este periodo.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Static warning, present from the start: not a live alert (role={undefined}). */}
          {!isReject && request.isOverdue ? (
            <Alert role={undefined}>
              <CalendarClock aria-hidden="true" />
              <AlertTitle>Esta solicitud ya empezó</AlertTitle>
              <AlertDescription>
                Empezaba el {formatDate(request.startDate)} y sigue pendiente. Apruébala solo si esas fechas ya
                estaban autorizadas.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor={noteId}>{texts.noteLabel}</Label>
            <Textarea
              ref={noteRef}
              id={noteId}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                if (noteError) setNoteError(null);
              }}
              maxLength={NOTE_MAX_LENGTH}
              required={isReject}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={noteError ? `${noteErrorId} ${noteHintId}` : noteHintId}
              disabled={locked}
            />
            {noteError ? (
              <p id={noteErrorId} className="text-sm text-destructive">
                {noteError}
              </p>
            ) : null}
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
            <AlertDialogCancel ref={backRef} type="button" disabled={mutation.isPending}>
              Volver
            </AlertDialogCancel>
            <Button type="submit" variant={isReject ? "destructive" : "default"} disabled={locked}>
              {mutation.isPending ? texts.pending : texts.confirm}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
