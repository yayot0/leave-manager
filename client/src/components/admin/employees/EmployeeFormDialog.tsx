import { useEffect, useId, useRef, useState } from "react";
import { Info, TriangleAlert } from "lucide-react";
import type { EmployeeInput, UpdateEmployeeInput } from "@/api/hr";
import type { BalanceSnapshot, Employee, EmployeeDetail, Role } from "@/api/types";
import { ROLE_LABELS } from "@/app/navigation";
import { useCreateEmployee, useDepartments, useHireDateImpact, useManagerOptions, useUpdateEmployee } from "@/hooks/hr";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { EntityDialog } from "@/hooks/use-entity-dialog";
import { formatDate, formatDateRange } from "@/lib/dates";
import { formatDays } from "@/lib/numbers";
import { CatalogFormDialog, FieldError } from "@/components/admin/CatalogFormDialog";
import { catalogFormError, fieldErrorProps, type CatalogField } from "@/components/admin/catalog-errors";
import { PasswordWarning } from "@/components/admin/employees/EmployeePasswordDialogs";
import { privilegedAcknowledgement } from "@/components/admin/employees/privileged";
import { TemporaryPasswordPanel } from "@/components/admin/employees/TemporaryPasswordPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const NAME_MAX = 60;
const EMAIL_MAX = 254;
const IMPACT_DEBOUNCE_MS = 400;
const ROLES: Role[] = ["EMPLOYEE", "MANAGER", "HR"];
const NO_MANAGER = "";

type Field = "firstName" | "lastName" | "email" | "role" | "department" | "manager" | "hireDate" | "acknowledged";
type FormErrors = Partial<Record<Field, string>>;
/** Order on screen: the first invalid field gets focus. */
const FIELD_ORDER: Field[] = [
  "firstName",
  "lastName",
  "email",
  "role",
  "department",
  "manager",
  "hireDate",
  "acknowledged",
];

interface FormValues {
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  departmentId: string;
  managerId: string;
  hireDate: string;
}

/**
 * Only what the client can check without business rules: required fields
 * and lengths. Manager eligibility, cycles, the last HR and the hire date
 * vs. existing requests are the API's (their errors land on the field).
 */
function validate(form: FormValues): FormErrors {
  const errors: FormErrors = {};
  const name = (value: string, label: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return `Escribe ${label} de al menos 2 caracteres.`;
    if (trimmed.length > NAME_MAX) return `No puede exceder ${NAME_MAX} caracteres.`;
    return undefined;
  };
  const firstName = name(form.firstName, "un nombre");
  if (firstName) errors.firstName = firstName;
  const lastName = name(form.lastName, "los apellidos");
  if (lastName) errors.lastName = lastName;
  const email = form.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > EMAIL_MAX) {
    errors.email = "Escribe un correo válido, p. ej. nombre@empresa.com.";
  }
  if (form.departmentId === "") errors.department = "Elige un departamento.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.hireDate)) errors.hireDate = "Elige la fecha de ingreso.";
  return errors;
}

function initialValues(employee: EmployeeDetail | null): FormValues {
  return {
    firstName: employee?.firstName ?? "",
    lastName: employee?.lastName ?? "",
    email: employee?.email ?? "",
    role: employee?.role ?? "EMPLOYEE",
    departmentId: employee?.departmentId ?? "",
    managerId: employee?.managerId ?? NO_MANAGER,
    hireDate: employee?.hireDate ?? "",
  };
}

/** Only what the user changed: a concurrent edit of another field is not overwritten. */
function changes(form: FormValues, current: EmployeeDetail): UpdateEmployeeInput {
  const email = form.email.trim().toLowerCase();
  const managerId = form.managerId === NO_MANAGER ? null : form.managerId;
  return {
    ...(form.firstName.trim() !== current.firstName ? { firstName: form.firstName.trim() } : {}),
    ...(form.lastName.trim() !== current.lastName ? { lastName: form.lastName.trim() } : {}),
    ...(email !== current.email ? { email } : {}),
    ...(form.role !== current.role ? { role: form.role } : {}),
    ...(form.departmentId !== (current.departmentId ?? "") ? { departmentId: form.departmentId } : {}),
    ...(managerId !== current.managerId ? { managerId } : {}),
    ...(form.hireDate !== current.hireDate ? { hireDate: form.hireDate } : {}),
  };
}

function BalanceLine({ label, balance }: { label: string; balance: BalanceSnapshot }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">
        <span className="font-medium">{formatDays(balance.available)} disponibles</span>{" "}
        <span className="text-muted-foreground">
          ({formatDays(balance.earned)} ganados, {balance.yearsOfService}{" "}
          {balance.yearsOfService === 1 ? "año" : "años"} de antigüedad; periodo{" "}
          {formatDateRange(balance.period.start, balance.period.end)})
        </span>
      </dd>
    </div>
  );
}

/**
 * How the employee's CURRENT balance changes with the new hire date, from
 * the API (same function as Mi saldo). Content changes after the dialog
 * opened, so it sits in an always-mounted live region that describes the
 * submit button (same pattern as the holiday impact).
 */
function HireDateImpactNotice({ id, employeeId, hireDate }: { id: string; employeeId: string; hireDate: string }) {
  const impact = useHireDateImpact(employeeId, hireDate, { enabled: hireDate !== "" });
  let content = null;
  if (hireDate === "") {
    content = null;
  } else if (impact.isPending) {
    content =
      impact.fetchStatus === "fetching" ? (
        <p className="text-sm text-muted-foreground">Calculando cómo cambia su saldo…</p>
      ) : null;
  } else if (impact.isError) {
    content = (
      <p className="text-sm text-muted-foreground">No se pudo calcular cómo cambia su saldo ({impact.error.message}).</p>
    );
  } else {
    const { current, proposed, problem } = impact.data;
    const delta = proposed.available - current.available;
    content = (
      <Alert role={undefined} variant={problem ? "destructive" : "default"}>
        {problem ? <TriangleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
        <AlertTitle>
          {problem
            ? "Esta fecha no se puede guardar"
            : delta === 0
              ? "Su saldo actual no cambia"
              : `Su saldo actual ${delta > 0 ? "sube" : "baja"} ${formatDays(Math.abs(delta))}`}
        </AlertTitle>
        <AlertDescription>
          {problem ? (
            <p>
              Tiene una solicitud activa que empieza el {formatDate(problem.earliestRequestStart)}: la fecha de ingreso
              no puede ser posterior.
            </p>
          ) : null}
          <dl className="mt-1 space-y-2">
            <BalanceLine label="Hoy" balance={current} />
            <BalanceLine label="Con la nueva fecha" balance={proposed} />
          </dl>
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

export type EmployeeFormTarget = { employee: EmployeeDetail | null };

/**
 * Create (employee null) or edit. Mounted once per opening (`key={session}`).
 * After creating, the same dialog shows the temporary password once
 * (TemporaryPasswordPanel) and forgets it when it finishes closing.
 */
export function EmployeeFormDialog({
  dialog,
  employee,
  onDone,
}: {
  dialog: EntityDialog<EmployeeFormTarget>;
  employee: EmployeeDetail | null;
  onDone: (message: string) => void;
}) {
  const isNew = employee === null;
  const create = useCreateEmployee();
  const update = useUpdateEmployee(employee?.id ?? "");
  const mutation = isNew ? create : update;
  const departments = useDepartments();
  const managers = useManagerOptions();

  const [form, setForm] = useState<FormValues>(() => initialValues(employee));
  const [errors, setErrors] = useState<FormErrors>({});
  /** Set once after creating; cleared when the dialog finishes closing. */
  const [created, setCreated] = useState<{ password: string; employee: Employee } | null>(null);

  const refs = {
    firstName: useRef<HTMLInputElement>(null),
    lastName: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    role: useRef<HTMLSelectElement>(null),
    department: useRef<HTMLSelectElement>(null),
    manager: useRef<HTMLSelectElement>(null),
    hireDate: useRef<HTMLInputElement>(null),
    acknowledged: useRef<HTMLInputElement>(null),
  };
  const ids = {
    firstName: useId(),
    lastName: useId(),
    email: useId(),
    role: useId(),
    department: useId(),
    manager: useId(),
    hireDate: useId(),
    impact: useId(),
    roleHint: useId(),
    managerHint: useId(),
    hireDateHint: useId(),
    acknowledged: useId(),
  };
  const errorIds = {
    firstName: useId(),
    lastName: useId(),
    email: useId(),
    role: useId(),
    department: useId(),
    manager: useId(),
    hireDate: useId(),
    acknowledged: useId(),
  };

  const permissions = employee?.permissions;
  const canEditRole = permissions?.canEditRole ?? true;
  const canEditManager = permissions?.canEditManager ?? true;
  const canEditHireDate = permissions?.canEditHireDate ?? true;

  const apiError = catalogFormError(mutation.error);
  const apiField = apiError?.field && (FIELD_ORDER as CatalogField[]).includes(apiError.field) ? (apiError.field as Field) : null;
  const fieldError = (field: Field) => errors[field] ?? (apiField === field ? (apiError?.message ?? null) : null);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K], field: Field) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors(({ [field]: _removed, ...rest }) => rest);
  };

  // An API error about one field: focus it once it is enabled again.
  useEffect(() => {
    if (apiField) refs[apiField].current?.focus();
    // refs are stable; re-run only when a new error arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiField, mutation.error]);

  const settledHireDate = useDebouncedValue(form.hireDate, IMPACT_DEBOUNCE_MS);
  const hireDateChanged = !isNew && form.hireDate !== employee.hireDate;
  const impactDate = hireDateChanged && settledHireDate === form.hireDate ? settledHireDate : "";

  // The person being edited cannot be their own manager: not offered (the API checks it anyway).
  const managerOptions = (managers.data ?? []).filter((option) => option.id !== employee?.id);
  // The current manager may no longer be eligible: still shown, so the select
  // does not lie. Only judged once the options loaded; until then (or if they
  // failed) the current manager is shown by name alone.
  const currentManager = employee?.manager ?? null;
  const currentManagerMissing =
    currentManager && !managerOptions.some((option) => option.id === currentManager.id) ? currentManager : null;
  const currentManagerLabel = currentManagerMissing
    ? `${currentManagerMissing.firstName} ${currentManagerMissing.lastName}${managers.isSuccess ? " (ya no puede ser jefe)" : ""}`
    : null;

  // Creating a MANAGER/HR account: HR sees its temporary password, so the
  // same stronger warning and checkbox as resetting one (impersonation risk).
  const [acknowledged, setAcknowledged] = useState(false);
  const acknowledgement = isNew ? privilegedAcknowledgement(form.role, form.firstName.trim() || "esa persona") : undefined;

  const fullName = `${form.firstName.trim()} ${form.lastName.trim()}`.trim();

  return (
    <CatalogFormDialog
      open={dialog.open}
      setOpen={dialog.setOpen}
      finalFocus={dialog.finalFocus}
      onClosed={() => setCreated(null)}
      replaceWith={
        created ? (
          <TemporaryPasswordPanel
            title={`${created.employee.firstName} ${created.employee.lastName} ya tiene cuenta`}
            password={created.password}
            personName={`${created.employee.firstName} ${created.employee.lastName}`}
          />
        ) : undefined
      }
      title={isNew ? "Nuevo empleado" : `Editar a ${employee.firstName} ${employee.lastName}`}
      description={
        isNew
          ? "Se generará una contraseña temporal que verás una sola vez."
          : "Solo se guardan los campos que cambies."
      }
      submitLabel={isNew ? "Crear empleado" : "Guardar cambios"}
      pendingLabel={isNew ? "Creando…" : "Guardando…"}
      isPending={mutation.isPending}
      locked={apiError?.locked}
      generalError={apiError && apiField === null ? apiError : null}
      errorSignal={mutation.error}
      initialFocus={refs.firstName}
      submitDescribedBy={hireDateChanged ? ids.impact : undefined}
      onSubmit={(close) => {
        const found = validate(form);
        if (acknowledgement !== undefined && !acknowledged) {
          found.acknowledged = "Marca la casilla para continuar.";
        }
        const firstInvalid = FIELD_ORDER.find((field) => found[field]);
        if (firstInvalid) {
          setErrors(found);
          refs[firstInvalid].current?.focus();
          return;
        }
        if (isNew) {
          const input: EmployeeInput = {
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            email: form.email.trim().toLowerCase(),
            role: form.role,
            departmentId: form.departmentId,
            managerId: form.managerId === NO_MANAGER ? null : form.managerId,
            hireDate: form.hireDate,
          };
          create.mutate(input, {
            onSuccess: (result) => {
              setCreated({ password: result.temporaryPassword, employee: result.employee });
              // The password now lives only in this dialog's state: drop it
              // from the mutation (gcTime 0 removes it from the cache).
              create.reset();
              onDone(`Empleado ${result.employee.firstName} ${result.employee.lastName} creado.`);
            },
          });
          return;
        }
        const input = changes(form, employee);
        if (Object.keys(input).length === 0) {
          close();
          return;
        }
        update.mutate(
          { ...input, expectedUpdatedAt: employee.updatedAt },
          {
            onSuccess: () => {
              close();
              onDone(`Datos de ${fullName} guardados.`);
            },
          },
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={ids.firstName}>Nombre</Label>
          <Input
            ref={refs.firstName}
            id={ids.firstName}
            value={form.firstName}
            maxLength={NAME_MAX}
            autoComplete="off"
            required
            disabled={mutation.isPending}
            onChange={(event) => set("firstName", event.target.value, "firstName")}
            {...fieldErrorProps(fieldError("firstName"), errorIds.firstName)}
          />
          <FieldError id={errorIds.firstName} message={fieldError("firstName")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.lastName}>Apellidos</Label>
          <Input
            ref={refs.lastName}
            id={ids.lastName}
            value={form.lastName}
            maxLength={NAME_MAX}
            autoComplete="off"
            required
            disabled={mutation.isPending}
            onChange={(event) => set("lastName", event.target.value, "lastName")}
            {...fieldErrorProps(fieldError("lastName"), errorIds.lastName)}
          />
          <FieldError id={errorIds.lastName} message={fieldError("lastName")} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.email}>Correo</Label>
        <Input
          ref={refs.email}
          id={ids.email}
          type="email"
          value={form.email}
          maxLength={EMAIL_MAX}
          autoComplete="off"
          spellCheck={false}
          required
          disabled={mutation.isPending}
          onChange={(event) => set("email", event.target.value, "email")}
          {...fieldErrorProps(fieldError("email"), errorIds.email)}
        />
        <FieldError id={errorIds.email} message={fieldError("email")} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={ids.role}>Rol</Label>
          <NativeSelect
            ref={refs.role}
            id={ids.role}
            className="w-full"
            value={form.role}
            disabled={mutation.isPending || !canEditRole}
            onChange={(event) => set("role", event.target.value as Role, "role")}
            {...fieldErrorProps(fieldError("role"), errorIds.role, canEditRole ? undefined : ids.roleHint)}
          >
            {ROLES.map((role) => (
              <NativeSelectOption key={role} value={role}>
                {ROLE_LABELS[role]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError id={errorIds.role} message={fieldError("role")} />
          {canEditRole ? null : (
            <p id={ids.roleHint} className="text-xs text-muted-foreground">
              No puedes cambiar tu propio rol; pídeselo a otra persona de RH.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.department}>Departamento</Label>
          <NativeSelect
            ref={refs.department}
            id={ids.department}
            className="w-full"
            value={form.departmentId}
            required
            disabled={mutation.isPending || departments.isPending}
            onChange={(event) => set("departmentId", event.target.value, "department")}
            {...fieldErrorProps(fieldError("department"), errorIds.department)}
          >
            <NativeSelectOption value="" disabled>
              {departments.isPending ? "Cargando…" : departments.isError ? "No se pudieron cargar" : "Elige uno"}
            </NativeSelectOption>
            {(departments.data ?? []).map((department) => (
              <NativeSelectOption key={department.id} value={department.id}>
                {department.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError id={errorIds.department} message={fieldError("department")} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.manager}>Jefe directo</Label>
        <NativeSelect
          ref={refs.manager}
          id={ids.manager}
          className="w-full"
          value={form.managerId}
          disabled={mutation.isPending || managers.isPending || !canEditManager}
          onChange={(event) => set("managerId", event.target.value, "manager")}
          {...fieldErrorProps(fieldError("manager"), errorIds.manager, ids.managerHint)}
        >
          <NativeSelectOption value={NO_MANAGER}>Sin jefe (decide RH)</NativeSelectOption>
          {currentManagerMissing ? (
            <NativeSelectOption value={currentManagerMissing.id}>
              {currentManagerLabel}
            </NativeSelectOption>
          ) : null}
          {managerOptions.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.firstName} {option.lastName} · {ROLE_LABELS[option.role]}
              {option.department ? ` · ${option.department.name}` : ""}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldError id={errorIds.manager} message={fieldError("manager")} />
        <p id={ids.managerHint} className="text-xs text-muted-foreground">
          {canEditManager
            ? "Aprueba o rechaza sus solicitudes. Solo personas activas con rol de Jefe de área o RH."
            : "No puedes cambiar tu propio jefe (es quien aprueba tus solicitudes); pídeselo a otra persona de RH."}
          {managers.isError ? " No se pudo cargar la lista de jefes." : ""}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.hireDate}>Fecha de ingreso</Label>
        <Input
          ref={refs.hireDate}
          id={ids.hireDate}
          type="date"
          min="1950-01-01"
          value={form.hireDate}
          required
          disabled={mutation.isPending || !canEditHireDate}
          onChange={(event) => set("hireDate", event.target.value, "hireDate")}
          {...fieldErrorProps(fieldError("hireDate"), errorIds.hireDate, ids.hireDateHint)}
        />
        <FieldError id={errorIds.hireDate} message={fieldError("hireDate")} />
        <p id={ids.hireDateHint} className="text-xs text-muted-foreground">
          {canEditHireDate
            ? "Define su antigüedad y sus días de vacaciones (LFT)."
            : "No puedes cambiar tu propia fecha de ingreso (cambia tus días de vacaciones); pídeselo a otra persona de RH."}
        </p>
      </div>

      {isNew ? null : <HireDateImpactNotice id={ids.impact} employeeId={employee.id} hireDate={impactDate} />}

      {acknowledgement !== undefined ? (
        <div className="space-y-3">
          <PasswordWarning role={form.role} firstName={form.firstName.trim() || "esta persona"} />
          <div className="flex items-start gap-2">
            <input
              ref={refs.acknowledged}
              id={ids.acknowledged}
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={acknowledged}
              disabled={mutation.isPending}
              onChange={(event) => {
                setAcknowledged(event.target.checked);
                setErrors(({ acknowledged: _removed, ...rest }) => rest);
              }}
              {...fieldErrorProps(fieldError("acknowledged"), errorIds.acknowledged)}
            />
            <div className="space-y-1">
              <label htmlFor={ids.acknowledged} className="text-sm">
                {acknowledgement}
              </label>
              <FieldError id={errorIds.acknowledged} message={fieldError("acknowledged")} />
            </div>
          </div>
        </div>
      ) : null}
    </CatalogFormDialog>
  );
}
