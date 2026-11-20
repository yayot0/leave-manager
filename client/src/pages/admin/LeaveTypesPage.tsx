import { useEffect, useId, useRef, useState } from "react";
import { CircleCheck, CircleSlash, ListChecks } from "lucide-react";
import type { HrLeaveType } from "@/api/types";
import type { UpdateLeaveTypeInput } from "@/api/hr";
import { useHrLeaveTypes, useSaveLeaveType, useUpdateLeaveType } from "@/hooks/hr";
import { useEntityDialog, type EntityDialog } from "@/hooks/use-entity-dialog";
import { formatBusinessDays } from "@/lib/numbers";
import { cn } from "@/lib/utils";
import { ActionStatus } from "@/components/admin/ActionStatus";
import { AdminSubnav } from "@/components/admin/AdminSubnav";
import { CatalogFormDialog, FieldError } from "@/components/admin/CatalogFormDialog";
import { catalogFormError, fieldErrorProps } from "@/components/admin/catalog-errors";
import { ConfirmActionDialog } from "@/components/admin/ConfirmActionDialog";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const NAME_MAX = 60;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,19}$/;
const MAX_DAYS_LIMIT = 365;

type OnDone = (message: string) => void;

function limitLabel(type: Pick<HrLeaveType, "maxBusinessDaysPerRequest">): string {
  return type.maxBusinessDaysPerRequest === null
    ? "Sin límite"
    : `${formatBusinessDays(type.maxBusinessDaysPerRequest)} por solicitud`;
}

function requestsLabel(count: number): string {
  return count === 1 ? "1 solicitud" : `${count} solicitudes`;
}

/** Text and icon, never color alone (WCAG 1.4.1). */
function ActiveBadge({ isActive }: { isActive: boolean }) {
  const Icon = isActive ? CircleCheck : CircleSlash;
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        isActive
          ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "bg-muted text-neutral-700 dark:text-neutral-300",
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {isActive ? "Activo" : "Inactivo"}
    </span>
  );
}

type Field = "code" | "name" | "max";
type FormErrors = Partial<Record<Field, string>>;
/** Order of the fields on screen: the first invalid one gets focus. */
const FIELD_ORDER: Field[] = ["code", "name", "max"];

/**
 * Same limits as the API (it re-checks everything, including the Art. 78
 * LFT rule, which stays a server rule: the client only shows its error).
 */
function validate(form: { code: string; name: string; max: string }, isNew: boolean): FormErrors {
  const errors: FormErrors = {};
  if (isNew && !CODE_PATTERN.test(form.code)) {
    errors.code = "De 2 a 20 caracteres: mayúsculas, números o _, empezando con letra (p. ej. PERM_GOCE).";
  }
  const name = form.name.trim();
  if (name.length < 2) errors.name = "Escribe un nombre de al menos 2 caracteres.";
  else if (name.length > NAME_MAX) errors.name = `El nombre no puede exceder ${NAME_MAX} caracteres.`;
  if (form.max.trim() !== "") {
    const value = Number(form.max);
    if (!Number.isInteger(value) || value < 1 || value > MAX_DAYS_LIMIT) {
      errors.max = `Escribe un número entero de 1 a ${MAX_DAYS_LIMIT}, o déjalo vacío para no poner límite.`;
    }
  }
  return errors;
}

/** What the form dialog was opened for: a new type, or editing one. */
type FormTarget = { leaveType: HrLeaveType | null };

/** Create (leaveType null) or edit. Mounted once per opening (`key={session}`). */
function LeaveTypeFormDialog({
  dialog,
  leaveType,
  onDone,
}: {
  dialog: EntityDialog<FormTarget>;
  leaveType: HrLeaveType | null;
  onDone: OnDone;
}) {
  const isNew = leaveType === null;
  const mutation = useSaveLeaveType();
  const [code, setCode] = useState(leaveType?.code ?? "");
  const [name, setName] = useState(leaveType?.name ?? "");
  const [counts, setCounts] = useState(leaveType?.countsAgainstVacationBalance ?? false);
  const [max, setMax] = useState(leaveType?.maxBusinessDaysPerRequest?.toString() ?? "");
  const [errors, setErrors] = useState<FormErrors>({});
  const refs = {
    code: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    max: useRef<HTMLInputElement>(null),
  };
  const ids = { code: useId(), name: useId(), counts: useId(), max: useId(), maxHint: useId(), countsHint: useId(), codeHint: useId() };
  const errorIds = { code: useId(), name: useId(), max: useId() };

  const apiError = catalogFormError(mutation.error);
  const apiField = apiError?.field === "code" || apiError?.field === "name" || apiError?.field === "max" ? apiError.field : null;
  const fieldError = (field: Field) => errors[field] ?? (apiField === field ? (apiError?.message ?? null) : null);
  const clear = (field: Field) => setErrors(({ [field]: _removed, ...rest }) => rest);

  // An API error about one field (duplicate code/name, Art. 78 limit): focus
  // it once it is enabled again (inputs are disabled while saving).
  useEffect(() => {
    if (apiField) refs[apiField].current?.focus();
    // refs are stable; re-run only when a new error arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiField, mutation.error]);

  /** Only what the user changed, so a concurrent edit of another field is not overwritten. */
  const changes = (current: HrLeaveType): UpdateLeaveTypeInput => {
    const nextMax = max.trim() === "" ? null : Number(max);
    return {
      ...(name.trim() !== current.name ? { name: name.trim() } : {}),
      ...(counts !== current.countsAgainstVacationBalance ? { countsAgainstVacationBalance: counts } : {}),
      ...(nextMax !== current.maxBusinessDaysPerRequest ? { maxBusinessDaysPerRequest: nextMax } : {}),
    };
  };

  return (
    <CatalogFormDialog
      open={dialog.open}
      setOpen={dialog.setOpen}
      finalFocus={dialog.finalFocus}
      title={isNew ? "Nuevo tipo de permiso" : `Editar ${leaveType.name}`}
      description={
        isNew
          ? "Aparecerá en Nueva solicitud en cuanto lo crees."
          : "Los cambios solo aplican a solicitudes nuevas: las que ya existen conservan si descontaban vacaciones y sus días."
      }
      submitLabel={isNew ? "Crear tipo" : "Guardar cambios"}
      pendingLabel="Guardando…"
      isPending={mutation.isPending}
      locked={apiError?.locked}
      generalError={apiError && apiField === null ? apiError : null}
      initialFocus={isNew ? refs.code : refs.name}
      onSubmit={(close) => {
        const found = validate({ code, name, max }, isNew);
        const firstInvalid = FIELD_ORDER.find((field) => found[field]);
        if (firstInvalid) {
          setErrors(found);
          refs[firstInvalid].current?.focus();
          return;
        }
        const trimmedName = name.trim();
        const onSuccess = () => {
          close();
          onDone(isNew ? `Tipo "${trimmedName}" creado.` : `Tipo "${trimmedName}" actualizado.`);
        };
        if (isNew) {
          mutation.mutate(
            {
              kind: "create",
              input: {
                code,
                name: trimmedName,
                countsAgainstVacationBalance: counts,
                maxBusinessDaysPerRequest: max.trim() === "" ? null : Number(max),
              },
            },
            { onSuccess },
          );
          return;
        }
        const input = changes(leaveType);
        if (Object.keys(input).length === 0) {
          // Nothing changed: nothing to send (the API would answer 400).
          close();
          return;
        }
        mutation.mutate(
          { kind: "update", id: leaveType.id, input: { ...input, expectedUpdatedAt: leaveType.updatedAt } },
          { onSuccess },
        );
      }}
    >
      {isNew ? (
        <div className="space-y-2">
          <Label htmlFor={ids.code}>Código</Label>
          <Input
            ref={refs.code}
            id={ids.code}
            value={code}
            maxLength={20}
            required
            autoComplete="off"
            spellCheck={false}
            className="font-mono uppercase"
            disabled={mutation.isPending}
            // Codes are uppercase identifiers: typed in uppercase as you go.
            onChange={(event) => {
              setCode(event.target.value.toUpperCase());
              clear("code");
            }}
            {...fieldErrorProps(fieldError("code"), errorIds.code, ids.codeHint)}
          />
          <FieldError id={errorIds.code} message={fieldError("code")} />
          <p id={ids.codeHint} className="text-xs text-muted-foreground">
            Mayúsculas, números o _ (p. ej. PERM_GOCE). No se puede cambiar después de crearlo.
          </p>
        </div>
      ) : (
        <p className="text-sm">
          Código: <span className="font-mono">{leaveType.code}</span>{" "}
          <span className="text-muted-foreground">(no se puede cambiar)</span>
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor={ids.name}>Nombre</Label>
        <Input
          ref={refs.name}
          id={ids.name}
          value={name}
          maxLength={NAME_MAX}
          required
          disabled={mutation.isPending}
          onChange={(event) => {
            setName(event.target.value);
            clear("name");
          }}
          {...fieldErrorProps(fieldError("name"), errorIds.name)}
        />
        <FieldError id={errorIds.name} message={fieldError("name")} />
      </div>

      <div className="flex items-start gap-2">
        <input
          id={ids.counts}
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={counts}
          disabled={mutation.isPending}
          onChange={(event) => setCounts(event.target.checked)}
          aria-describedby={ids.countsHint}
        />
        <div className="space-y-0.5">
          <Label htmlFor={ids.counts}>Descuenta de las vacaciones</Label>
          <p id={ids.countsHint} className="text-xs text-muted-foreground">
            Las solicitudes de este tipo restan días del saldo de vacaciones.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.max}>Máximo de días hábiles por solicitud (opcional)</Label>
        <Input
          ref={refs.max}
          id={ids.max}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_DAYS_LIMIT}
          step={1}
          value={max}
          disabled={mutation.isPending}
          onChange={(event) => {
            setMax(event.target.value);
            clear("max");
          }}
          {...fieldErrorProps(fieldError("max"), errorIds.max, ids.maxHint)}
        />
        <FieldError id={errorIds.max} message={fieldError("max")} />
        <p id={ids.maxHint} className="text-xs text-muted-foreground">
          Déjalo vacío para no poner límite. Si descuenta de las vacaciones, sin límite o 12 o más (Art. 78 LFT).
        </p>
      </div>
    </CatalogFormDialog>
  );
}

/** Deactivate or reactivate. Mounted once per opening (`key={session}`). */
function ToggleActiveDialog({
  dialog,
  leaveType,
  onDone,
}: {
  dialog: EntityDialog<HrLeaveType>;
  leaveType: HrLeaveType;
  onDone: OnDone;
}) {
  const update = useUpdateLeaveType();
  const deactivating = leaveType.isActive;
  return (
    <ConfirmActionDialog
      open={dialog.open}
      setOpen={dialog.setOpen}
      finalFocus={dialog.finalFocus}
      title={deactivating ? `¿Desactivar ${leaveType.name}?` : `¿Reactivar ${leaveType.name}?`}
      description={
        deactivating
          ? `Ya no se ofrecerá en Nueva solicitud. Sus ${requestsLabel(leaveType.requestCount)} no cambian y las pendientes se pueden seguir aprobando, rechazando o cancelando.`
          : "Volverá a ofrecerse en Nueva solicitud."
      }
      confirmLabel={deactivating ? "Sí, desactivar" : "Sí, reactivar"}
      pendingLabel={deactivating ? "Desactivando…" : "Reactivando…"}
      destructive={deactivating}
      action={{
        isPending: update.isPending,
        error: update.error,
        run: (callbacks) =>
          update.mutate(
            { id: leaveType.id, input: { isActive: !deactivating, expectedUpdatedAt: leaveType.updatedAt } },
            callbacks,
          ),
      }}
      onDone={() => onDone(`Tipo "${leaveType.name}" ${deactivating ? "desactivado" : "reactivado"}.`)}
    />
  );
}

interface RowActionsProps {
  leaveType: HrLeaveType;
  onEdit: (leaveType: HrLeaveType) => void;
  onToggle: (leaveType: HrLeaveType) => void;
}

/** Only buttons: the dialogs live at page level (see useEntityDialog). */
function RowActions({ leaveType, onEdit, onToggle }: RowActionsProps) {
  const toggleLabel = leaveType.isActive ? "Desactivar" : "Reactivar";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`Editar ${leaveType.name}`}
        onClick={() => onEdit(leaveType)}
      >
        Editar
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`${toggleLabel} ${leaveType.name}`}
        onClick={() => onToggle(leaveType)}
      >
        {toggleLabel}
      </Button>
    </div>
  );
}

type ListProps = Omit<RowActionsProps, "leaveType"> & { leaveTypes: HrLeaveType[] };

function LeaveTypesTable({ leaveTypes, ...actions }: ListProps) {
  return (
    <div className="hidden md:block">
      <Card className="py-0">
        <Table>
          <caption className="sr-only">Tipos de permiso</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Nombre</TableHead>
              <TableHead scope="col">Descuenta vacaciones</TableHead>
              <TableHead scope="col">Máximo</TableHead>
              <TableHead scope="col">Estado</TableHead>
              <TableHead scope="col" className="text-right">
                Solicitudes
              </TableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Acciones</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaveTypes.map((leaveType) => (
              <TableRow key={leaveType.id}>
                <TableHead scope="row" className="font-normal text-foreground">
                  <span className="block font-medium">{leaveType.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{leaveType.code}</span>
                </TableHead>
                <TableCell>{leaveType.countsAgainstVacationBalance ? "Sí" : "No"}</TableCell>
                <TableCell>{limitLabel(leaveType)}</TableCell>
                <TableCell>
                  <ActiveBadge isActive={leaveType.isActive} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{leaveType.requestCount}</TableCell>
                <TableCell>
                  <RowActions leaveType={leaveType} {...actions} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function LeaveTypeCards({ leaveTypes, ...actions }: ListProps) {
  return (
    <ul className="space-y-3 md:hidden" aria-label="Tipos de permiso">
      {leaveTypes.map((leaveType) => (
        <li key={leaveType.id}>
          <Card size="sm">
            <CardContent className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{leaveType.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{leaveType.code}</p>
                </div>
                <ActiveBadge isActive={leaveType.isActive} />
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted-foreground">Descuenta vacaciones</dt>
                <dd>{leaveType.countsAgainstVacationBalance ? "Sí" : "No"}</dd>
                <dt className="text-muted-foreground">Máximo</dt>
                <dd>{limitLabel(leaveType)}</dd>
                <dt className="text-muted-foreground">Solicitudes</dt>
                <dd>{leaveType.requestCount}</dd>
              </dl>
              <RowActions leaveType={leaveType} {...actions} />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <ListChecks className="size-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="font-semibold">Aún no hay tipos de permiso</h2>
          <p className="text-sm text-muted-foreground">Sin tipos, los empleados no pueden pedir vacaciones ni permisos.</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function LeaveTypesPage() {
  const leaveTypes = useHrLeaveTypes();
  const [status, setStatus] = useState<string | null>(null);
  const formDialog = useEntityDialog<FormTarget>();
  const toggleDialog = useEntityDialog<HrLeaveType>();
  const actions = {
    onEdit: (leaveType: HrLeaveType) => formDialog.show({ leaveType }),
    onToggle: (leaveType: HrLeaveType) => toggleDialog.show(leaveType),
  };

  return (
    <>
      <PageHeading
        title="Tipos de permiso"
        description="Lo que los empleados pueden pedir. Los inactivos ya no se ofrecen, pero sus solicitudes se conservan."
      />
      <AdminSubnav />
      <ActionStatus message={status} />
      <div className="mb-4 flex justify-end">
        <Button aria-haspopup="dialog" onClick={() => formDialog.show({ leaveType: null })}>
          Nuevo tipo de permiso
        </Button>
      </div>
      {leaveTypes.isPending ? (
        <LoadingBlock label="Cargando tipos de permiso…" />
      ) : leaveTypes.isError ? (
        <QueryError
          title="No se pudieron cargar los tipos de permiso"
          error={leaveTypes.error}
          onRetry={() => void leaveTypes.refetch()}
          isRetrying={leaveTypes.isFetching}
        />
      ) : leaveTypes.data.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <LeaveTypesTable leaveTypes={leaveTypes.data} {...actions} />
          <LeaveTypeCards leaveTypes={leaveTypes.data} {...actions} />
        </>
      )}

      {/* Page-level dialogs: they survive their row changing or disappearing behind them. */}
      {formDialog.target ? (
        <LeaveTypeFormDialog
          key={formDialog.session}
          dialog={formDialog}
          leaveType={formDialog.target.leaveType}
          onDone={setStatus}
        />
      ) : null}
      {toggleDialog.target ? (
        <ToggleActiveDialog
          key={toggleDialog.session}
          dialog={toggleDialog}
          leaveType={toggleDialog.target}
          onDone={setStatus}
        />
      ) : null}
    </>
  );
}
