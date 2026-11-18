import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { CircleAlert, Info, LoaderCircle } from "lucide-react";
import { ApiError } from "@/api/client";
import type { LeaveRequestPreview } from "@/api/types";
import { requestDetailPath } from "@/app/paths";
import { useCreateLeaveRequest, useLeaveRequestPreview, useLeaveTypes } from "@/hooks/leave-requests";
import { formatDate, todayISO } from "@/lib/dates";
import { formatBusinessDays, formatDays, formatNumber } from "@/lib/numbers";
import { cn } from "@/lib/utils";
import { PageHeading } from "@/components/PageHeading";
import { QueryError } from "@/components/QueryStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

const REASON_MAX_LENGTH = 500;

/** Titles by status; the message itself always comes from the API. */
function submitErrorTitle(error: Error): string {
  if (!(error instanceof ApiError)) return "No se pudo enviar la solicitud";
  if (error.status === 409) return "Las fechas se enciman con otra solicitud";
  if (error.status === 422) return "No te alcanzan los días";
  if (error.status === 400) return "Revisa los datos de la solicitud";
  return "No se pudo enviar la solicitud";
}

function PreviewResult({ preview }: { preview: LeaveRequestPreview }) {
  const { balance, problems } = preview;
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">Días hábiles</dt>
          <dd className="text-2xl font-semibold tabular-nums">{preview.businessDays}</dd>
        </div>
        {balance ? (
          <div>
            <dt className="text-sm text-muted-foreground">Saldo del periodo</dt>
            <dd className="text-2xl font-semibold tabular-nums">
              {formatNumber(balance.available)} → {formatNumber(balance.availableAfter)}
            </dd>
            <dd className="text-sm text-muted-foreground">
              {balance.availableAfter >= 0
                ? `Te quedarían ${formatDays(balance.availableAfter)} de ${formatDays(balance.available)} disponibles`
                : `Te faltarían ${formatDays(-balance.availableAfter)}: tienes ${formatDays(Math.max(balance.available, 0))} disponibles`}{" "}
              en el periodo del {formatDate(balance.period.start)} al {formatDate(balance.period.end)}.
            </dd>
          </div>
        ) : preview.leaveType ? (
          <div>
            <dt className="text-sm text-muted-foreground">Saldo de vacaciones</dt>
            <dd className="text-sm">{preview.leaveType.name} no descuenta de tus vacaciones.</dd>
          </div>
        ) : null}
      </dl>

      {problems.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-destructive">Así no se podría crear la solicitud:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem.code}>{problem.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Todo en orden. Al enviarla, se apartan {formatBusinessDays(preview.businessDays)} mientras se decide.
        </p>
      )}
    </div>
  );
}

interface PreviewPanelProps {
  complete: boolean;
  preview: ReturnType<typeof useLeaveRequestPreview>;
}

function PreviewPanel({ complete, preview: { query: preview, isOutdated } }: PreviewPanelProps) {
  const headingId = useId();

  let content;
  if (!complete) {
    content = <p className="text-sm text-muted-foreground">Elige el tipo y las fechas para ver cuántos días hábiles son.</p>;
  } else if (preview.isError) {
    const details = preview.error instanceof ApiError ? preview.error.details : [];
    content = (
      <div className="space-y-1 text-sm text-destructive">
        <p>{details.length > 0 ? "Revisa las fechas:" : preview.error.message}</p>
        {details.length > 0 ? (
          <ul className="list-disc pl-5">
            {details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  } else if (preview.data) {
    content = (
      <div className="space-y-3">
        {isOutdated ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Actualizando…
          </p>
        ) : null}
        {/* Dimmed while it describes the previous values, so "Todo en orden" is not taken at face value. */}
        <div className={cn("transition-opacity", isOutdated && "opacity-50")}>
          <PreviewResult preview={preview.data} />
        </div>
      </div>
    );
  } else {
    content = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Calculando…
      </p>
    );
  }

  return (
    <Card aria-labelledby={headingId} role="region">
      <CardHeader>
        <CardTitle>
          <h2 id={headingId}>Vista previa</h2>
        </CardTitle>
      </CardHeader>
      {/* Announced when it changes, without moving focus out of the form. */}
      <CardContent aria-live="polite" aria-busy={isOutdated || preview.isFetching}>
        {content}
      </CardContent>
    </Card>
  );
}

export function NewRequestPage() {
  const navigate = useNavigate();
  const leaveTypes = useLeaveTypes();
  const create = useCreateLeaveRequest();

  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");

  // Dates stay as the "YYYY-MM-DD" strings the date input gives: no Date
  // objects, so no timezone shifts on the way to the API.
  const previewInput = { leaveTypeId, startDate, endDate };
  const complete = Boolean(leaveTypeId && startDate && endDate);
  const preview = useLeaveRequestPreview(previewInput);

  const typeId = useId();
  const startId = useId();
  const endId = useId();
  const reasonId = useId();
  const reasonHintId = useId();
  const errorId = useId();

  /** Editing after a failed submit clears that error: it was about the old values. */
  const edit = (setter: (value: string) => void, value: string) => {
    if (create.isError) create.reset();
    setter(value);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate(
      { leaveTypeId, startDate, endDate, reason: reason.trim() || undefined },
      { onSuccess: (created) => void navigate(requestDetailPath(created.id)) },
    );
  };

  const submitError = create.isError ? create.error : null;
  const submitDetails = submitError instanceof ApiError ? submitError.details : [];
  // Mark the field the error is about, so a screen reader repeats the error
  // when going back to it. The API's `code` says which one; everything else
  // in a 400/409/422 is about the dates (range, past, overlap, balance).
  const fieldError = submitError instanceof ApiError && [400, 409, 422].includes(submitError.status);
  const typeInvalid = fieldError && submitError.code === "INVALID_LEAVE_TYPE";
  const datesInvalid = fieldError && !typeInvalid;
  const invalidProps = { "aria-invalid": true, "aria-describedby": errorId } as const;
  const typeFieldProps = typeInvalid ? invalidProps : {};
  const dateFieldProps = datesInvalid ? invalidProps : {};
  const noLeaveTypes = leaveTypes.isSuccess && leaveTypes.data.length === 0;

  return (
    <>
      <PageHeading title="Nueva solicitud" description="Pide vacaciones o un permiso." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
        <Card>
          <CardContent>
            {leaveTypes.isError ? (
              <QueryError
                title="No se pudieron cargar los tipos de permiso"
                error={leaveTypes.error}
                onRetry={() => void leaveTypes.refetch()}
                isRetrying={leaveTypes.isFetching}
              />
            ) : noLeaveTypes ? (
              <div className="space-y-1 py-4 text-center">
                <h2 className="font-semibold">No hay tipos de permiso disponibles</h2>
                <p className="text-sm text-muted-foreground">
                  Por ahora no puedes crear solicitudes. Contacta a Recursos Humanos.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor={typeId}>Tipo de permiso</Label>
                  <NativeSelect
                    id={typeId}
                    className="w-full"
                    value={leaveTypeId}
                    onChange={(event) => edit(setLeaveTypeId, event.target.value)}
                    disabled={leaveTypes.isPending}
                    required
                    {...typeFieldProps}
                  >
                    <NativeSelectOption value="" disabled>
                      {leaveTypes.isPending ? "Cargando tipos…" : "Elige un tipo"}
                    </NativeSelectOption>
                    {leaveTypes.data?.map((type) => (
                      <NativeSelectOption key={type.id} value={type.id}>
                        {type.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={startId}>Fecha de inicio</Label>
                    <Input
                      id={startId}
                      type="date"
                      value={startDate}
                      min={todayISO()}
                      onChange={(event) => edit(setStartDate, event.target.value)}
                      required
                      {...dateFieldProps}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={endId}>Fecha de fin</Label>
                    <Input
                      id={endId}
                      type="date"
                      value={endDate}
                      min={startDate || todayISO()}
                      onChange={(event) => edit(setEndDate, event.target.value)}
                      required
                      {...dateFieldProps}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor={reasonId}>Motivo (opcional)</Label>
                  <Textarea
                    id={reasonId}
                    value={reason}
                    onChange={(event) => edit(setReason, event.target.value)}
                    maxLength={REASON_MAX_LENGTH}
                    aria-describedby={reasonHintId}
                  />
                  <p id={reasonHintId} className="text-xs text-muted-foreground">
                    {reason.length}/{REASON_MAX_LENGTH} caracteres
                  </p>
                </div>

                {submitError ? (
                  <Alert variant="destructive" id={errorId}>
                    <CircleAlert aria-hidden="true" />
                    <AlertTitle>{submitErrorTitle(submitError)}</AlertTitle>
                    <AlertDescription>
                      <p>{submitError.message}</p>
                      {submitDetails.length > 0 ? (
                        <ul className="list-disc pl-5">
                          {submitDetails.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={create.isPending || leaveTypes.isPending}>
                    {create.isPending ? "Enviando…" : "Enviar solicitud"}
                  </Button>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Info className="size-3.5" aria-hidden="true" />
                    Tu jefe directo (o Recursos Humanos) la revisará.
                  </p>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        <PreviewPanel complete={complete} preview={preview} />
      </div>
    </>
  );
}
