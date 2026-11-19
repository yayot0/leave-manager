import { useEffect, useId, useRef, useState } from "react";
import { CalendarX2, Info, TriangleAlert } from "lucide-react";
import type { Holiday, HolidayImpact } from "@/api/types";
import { useCreateHoliday, useDeleteHoliday, useHolidayImpact, useHolidays } from "@/hooks/hr";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useEntityDialog, type EntityDialog } from "@/hooks/use-entity-dialog";
import { formatDate, formatWeekday, todayISO } from "@/lib/dates";
import { ActionStatus } from "@/components/admin/ActionStatus";
import { AdminSubnav } from "@/components/admin/AdminSubnav";
import { CatalogFormDialog, FieldError } from "@/components/admin/CatalogFormDialog";
import { catalogFormError, fieldErrorProps } from "@/components/admin/catalog-errors";
import { ConfirmActionDialog } from "@/components/admin/ConfirmActionDialog";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const NAME_MAX = 60;
/** Same range the API accepts (it re-checks). */
const MIN_DATE = "2000-01-01";
const MAX_DATE = "2100-12-31";
/** Typing the year in a date input goes through "0002-…", "0020-…": wait until it settles. */
const IMPACT_DEBOUNCE_MS = 400;

type OnDone = (message: string) => void;

function requestsCount(count: number): string {
  return count === 1 ? "1 solicitud" : `${count} solicitudes`;
}

/** "2 descuentan saldo y 1 no; 1 ya terminó y 2 están en curso o por venir." */
function breakdownText({ breakdown }: HolidayImpact): string {
  const { countingBalance, notCountingBalance, past, upcoming } = breakdown;
  const counting = `${countingBalance} ${countingBalance === 1 ? "descuenta" : "descuentan"} saldo y ${notCountingBalance} no`;
  const timing = `${past} ya ${past === 1 ? "terminó" : "terminaron"} y ${upcoming} ${upcoming === 1 ? "está" : "están"} en curso o por venir`;
  return `${counting}; ${timing}.`;
}

/** The impact as a sentence, for the success message after adding/removing. */
function impactSummary(impact: HolidayImpact): string {
  if (impact.affectedRequests === 0) {
    return "";
  }
  return ` ${requestsCount(impact.affectedRequests)} activas cruzan esa fecha y no se recalcularon (${breakdownText(impact)})${
    impact.breakdown.countingBalance > 0 ? " Si hace falta, corrige el saldo con un ajuste." : ""
  }`;
}

/**
 * What adding/removing a holiday on `date` does to existing requests: their
 * business days were fixed when they were created and are NOT recalculated.
 * The numbers come from the API (all 0 on weekends, which never counted).
 *
 * The content changes after the dialog opened (the date was chosen, or the
 * answer arrived), so it sits in a live region that is ALWAYS mounted
 * (role="status": announced politely, without interrupting), and its `id`
 * describes the confirm button, so it is read again when reaching it.
 */
function ImpactNotice({ id, date, adding }: { id: string; date: string; adding: boolean }) {
  const impact = useHolidayImpact(date, { enabled: date !== "" });

  let content = null;
  if (date === "") {
    content = null;
  } else if (impact.isPending) {
    content = impact.fetchStatus === "fetching" ? (
      <p className="text-sm text-muted-foreground">Revisando solicitudes que cruzan esa fecha…</p>
    ) : null;
  } else if (impact.isError) {
    content = (
      <p className="text-sm text-muted-foreground">
        No se pudo revisar qué solicitudes cruzan esa fecha ({impact.error.message}).
      </p>
    );
  } else if (impact.data.affectedRequests === 0) {
    content = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Info className="size-4 shrink-0" aria-hidden="true" />
        Ninguna solicitud activa cambia por este festivo.
      </p>
    );
  } else {
    const { affectedRequests, breakdown } = impact.data;
    content = (
      // A notice, not an error: role={undefined} (the live region announces it).
      <Alert role={undefined}>
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>
          {requestsCount(affectedRequests)} {affectedRequests === 1 ? "activa cruza" : "activas cruzan"} esta fecha
        </AlertTitle>
        <AlertDescription>
          <p>{breakdownText(impact.data)}</p>
          <p>
            {adding
              ? "No se recalcularán: seguirán contando ese día como hábil."
              : "No se recalcularán: seguirán sin contar ese día."}{" "}
            {breakdown.countingBalance > 0
              ? "Las que descuentan saldo (también las ya terminadas) pueden necesitar un ajuste."
              : "Ninguna descuenta saldo: no hace falta ajustar."}
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div id={id} role="status">
      {content}
    </div>
  );
}

/** Mounted once per opening (`key={session}`). */
function AddHolidayDialog({
  dialog,
  onDone,
}: {
  dialog: EntityDialog<true>;
  onDone: (message: string, year: number) => void;
}) {
  const create = useCreateHoliday();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ date?: string; name?: string }>({});
  const dateRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const ids = { date: useId(), name: useId(), dateError: useId(), nameError: useId(), impact: useId() };
  const settledDate = useDebouncedValue(date, IMPACT_DEBOUNCE_MS);

  const apiError = catalogFormError(create.error);
  const dateError = errors.date ?? (apiError?.field === "date" ? apiError.message : null);
  const nameError = errors.name ?? (apiError?.field === "name" ? apiError.message : null);

  // A duplicate date from the API: focus the date once it is enabled again.
  useEffect(() => {
    if (apiError?.field === "date") dateRef.current?.focus();
  }, [apiError?.field, create.error]);

  return (
    <CatalogFormDialog
      open={dialog.open}
      setOpen={dialog.setOpen}
      finalFocus={dialog.finalFocus}
      title="Agregar festivo"
      description="Los días festivos no cuentan como hábiles en las solicitudes nuevas."
      submitLabel="Agregar"
      pendingLabel="Agregando…"
      isPending={create.isPending}
      locked={apiError?.locked}
      generalError={apiError && apiError.field === null ? apiError : null}
      initialFocus={dateRef}
      submitDescribedBy={ids.impact}
      onSubmit={(close) => {
        const found: { date?: string; name?: string } = {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < MIN_DATE || date > MAX_DATE) {
          found.date = "Elige una fecha entre 2000 y 2100.";
        }
        const trimmed = name.trim();
        if (trimmed.length < 2) found.name = "Escribe un nombre de al menos 2 caracteres.";
        if (found.date || found.name) {
          setErrors(found);
          (found.date ? dateRef : nameRef).current?.focus();
          return;
        }
        create.mutate(
          { date, name: trimmed },
          {
            onSuccess: (result) => {
              close();
              onDone(
                `Festivo "${trimmed}" agregado el ${formatDate(date)}.${impactSummary(result)}`,
                Number(date.slice(0, 4)),
              );
            },
          },
        );
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={ids.date}>Fecha</Label>
        <Input
          ref={dateRef}
          id={ids.date}
          type="date"
          min={MIN_DATE}
          max={MAX_DATE}
          value={date}
          required
          disabled={create.isPending}
          onChange={(event) => {
            setDate(event.target.value);
            setErrors(({ date: _removed, ...rest }) => rest);
          }}
          {...fieldErrorProps(dateError, ids.dateError)}
        />
        <FieldError id={ids.dateError} message={dateError} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.name}>Nombre</Label>
        <Input
          ref={nameRef}
          id={ids.name}
          value={name}
          maxLength={NAME_MAX}
          required
          placeholder="Día de la Revolución Mexicana"
          disabled={create.isPending}
          onChange={(event) => {
            setName(event.target.value);
            setErrors(({ name: _removed, ...rest }) => rest);
          }}
          {...fieldErrorProps(nameError, ids.nameError)}
        />
        <FieldError id={ids.nameError} message={nameError} />
      </div>
      {/* Only a settled, in-range date is asked about (no request per keystroke). */}
      <ImpactNotice
        id={ids.impact}
        date={settledDate >= MIN_DATE && settledDate <= MAX_DATE && settledDate === date ? settledDate : ""}
        adding
      />
    </CatalogFormDialog>
  );
}

/** Mounted once per opening (`key={session}`); the impact is asked when it opens. */
function RemoveHolidayDialog({
  dialog,
  holiday,
  onDone,
}: {
  dialog: EntityDialog<Holiday>;
  holiday: Holiday;
  onDone: OnDone;
}) {
  const remove = useDeleteHoliday();
  const impactId = useId();
  return (
    <ConfirmActionDialog
      open={dialog.open}
      setOpen={dialog.setOpen}
      finalFocus={dialog.finalFocus}
      title={`¿Quitar ${holiday.name}?`}
      description={`${formatDate(holiday.date)} volverá a contar como día hábil en las solicitudes nuevas.`}
      confirmLabel="Sí, quitar"
      pendingLabel="Quitando…"
      destructive
      confirmDescribedBy={impactId}
      action={{
        isPending: remove.isPending,
        error: remove.error,
        run: ({ onSuccess }) =>
          remove.mutate(holiday.id, {
            onSuccess: (result) => {
              onSuccess();
              onDone(`Festivo "${holiday.name}" quitado.${impactSummary(result)}`);
            },
          }),
      }}
      onRemoved={dialog.markRemoved}
    >
      <ImpactNotice id={impactId} date={holiday.date} adding={false} />
    </ConfirmActionDialog>
  );
}

interface ListProps {
  holidays: Holiday[];
  onRemove: (holiday: Holiday) => void;
}

/** Only a button: the dialog lives at page level (see useEntityDialog). */
function RemoveButton({ holiday, onRemove }: { holiday: Holiday; onRemove: (holiday: Holiday) => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-haspopup="dialog"
      aria-label={`Quitar ${holiday.name}, ${formatDate(holiday.date)}`}
      onClick={() => onRemove(holiday)}
    >
      Quitar
    </Button>
  );
}

function HolidaysTable({ holidays, onRemove }: ListProps) {
  return (
    <div className="hidden md:block">
      <Card className="py-0">
        <Table>
          <caption className="sr-only">Festivos</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Fecha</TableHead>
              <TableHead scope="col">Día</TableHead>
              <TableHead scope="col">Nombre</TableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Acciones</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holidays.map((holiday) => (
              <TableRow key={holiday.id}>
                <TableHead scope="row" className="font-medium text-foreground">
                  <time dateTime={holiday.date}>{formatDate(holiday.date)}</time>
                </TableHead>
                <TableCell className="capitalize">{formatWeekday(holiday.date)}</TableCell>
                <TableCell>{holiday.name}</TableCell>
                <TableCell className="text-right">
                  <RemoveButton holiday={holiday} onRemove={onRemove} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function HolidayCards({ holidays, onRemove }: ListProps) {
  return (
    <ul className="space-y-3 md:hidden" aria-label="Festivos">
      {holidays.map((holiday) => (
        <li key={holiday.id}>
          <Card size="sm">
            <CardContent className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{holiday.name}</p>
                <p className="text-sm text-muted-foreground">
                  <span className="capitalize">{formatWeekday(holiday.date)}</span>,{" "}
                  <time dateTime={holiday.date}>{formatDate(holiday.date)}</time>
                </p>
              </div>
              <RemoveButton holiday={holiday} onRemove={onRemove} />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ year }: { year: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <CalendarX2 className="size-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="font-semibold">No hay festivos en {year}</h2>
          <p className="text-sm text-muted-foreground">Agrega los días de descanso obligatorio de ese año.</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function HolidaysPage() {
  const currentYear = Number(todayISO().slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const holidays = useHolidays(year);
  const [status, setStatus] = useState<string | null>(null);
  const addDialog = useEntityDialog<true>();
  const removeDialog = useEntityDialog<Holiday>();
  const yearId = useId();
  // The selected year is always offered, even if it is outside the default range.
  const years = [...new Set([currentYear - 1, currentYear, currentYear + 1, currentYear + 2, year])].sort(
    (a, b) => a - b,
  );

  return (
    <>
      <PageHeading title="Festivos" description="Días de descanso obligatorio: no cuentan como hábiles." />
      <AdminSubnav />
      <ActionStatus message={status} />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Label htmlFor={yearId}>Año</Label>
          <NativeSelect id={yearId} value={String(year)} onChange={(event) => setYear(Number(event.target.value))}>
            {years.map((option) => (
              <NativeSelectOption key={option} value={String(option)}>
                {option}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button aria-haspopup="dialog" onClick={() => addDialog.show(true)}>
          Agregar festivo
        </Button>
      </div>
      {holidays.isPending ? (
        <LoadingBlock label={`Cargando festivos de ${year}…`} />
      ) : holidays.isError ? (
        <QueryError
          title="No se pudieron cargar los festivos"
          error={holidays.error}
          onRetry={() => void holidays.refetch()}
          isRetrying={holidays.isFetching}
        />
      ) : holidays.data.length === 0 ? (
        <EmptyState year={year} />
      ) : (
        <>
          <HolidaysTable holidays={holidays.data} onRemove={removeDialog.show} />
          <HolidayCards holidays={holidays.data} onRemove={removeDialog.show} />
        </>
      )}

      {/* Page-level dialogs: they survive their row disappearing behind them. */}
      {addDialog.target ? (
        <AddHolidayDialog
          key={addDialog.session}
          dialog={addDialog}
          onDone={(message, addedYear) => {
            setStatus(message);
            // Show the year where the new holiday landed.
            setYear(addedYear);
          }}
        />
      ) : null}
      {removeDialog.target ? (
        <RemoveHolidayDialog
          key={removeDialog.session}
          dialog={removeDialog}
          holiday={removeDialog.target}
          onDone={setStatus}
        />
      ) : null}
    </>
  );
}
