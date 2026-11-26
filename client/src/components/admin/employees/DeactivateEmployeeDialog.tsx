import { useId } from "react";
import { Link } from "react-router";
import { Info, TriangleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import type { DeactivationImpact, DeactivationRequest, EmployeeDetail } from "@/api/types";
import { employeeDetailPath, fromEmployeeState, requestDetailPath } from "@/app/paths";
import { useDeactivateEmployee, useDeactivationImpact } from "@/hooks/hr";
import type { EntityDialog } from "@/hooks/use-entity-dialog";
import { formatDateRange } from "@/lib/dates";
import { formatBusinessDays } from "@/lib/numbers";
import { ConfirmActionDialog } from "@/components/admin/ConfirmActionDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

function requestsCount(count: number): string {
  return count === 1 ? "1 solicitud" : `${count} solicitudes`;
}

/** The overdue requests, from the preview or from the POST's 409 (`data.requests`). */
function overdueFromError(error: Error | null): DeactivationRequest[] | null {
  if (!(error instanceof ApiError) || error.code !== "HAS_OVERDUE_PENDING_REQUESTS") return null;
  const data = error.data as { requests?: unknown } | undefined;
  if (!Array.isArray(data?.requests)) return null;
  // Only well-formed items are rendered: a surprise shape must not crash the dialog.
  const requests = data.requests.filter(isDeactivationRequest);
  return requests.length > 0 ? requests : null;
}

function isDeactivationRequest(value: unknown): value is DeactivationRequest {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const leaveType = item.leaveType as Record<string, unknown> | null | undefined;
  return (
    typeof item.id === "string" &&
    typeof item.startDate === "string" &&
    typeof item.endDate === "string" &&
    typeof item.businessDays === "number" &&
    typeof leaveType?.name === "string"
  );
}

function OverdueList({ employeeId, requests }: { employeeId: string; requests: DeactivationRequest[] }) {
  return (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      {requests.map((request) => (
        <li key={request.id}>
          <Link
            to={requestDetailPath(request.id)}
            // Its "Volver" returns to this employee (see useBackLink).
            state={fromEmployeeState(employeeId)}
            className="font-medium underline underline-offset-4"
          >
            {request.leaveType.name}: {formatDateRange(request.startDate, request.endDate)}
          </Link>{" "}
          ({formatBusinessDays(request.businessDays)})
        </li>
      ))}
    </ul>
  );
}

function ImpactContent({ employee, impact }: { employee: EmployeeDetail; impact: DeactivationImpact }) {
  const name = employee.firstName;
  if (impact.blocker === "HAS_ACTIVE_REPORTS") {
    return (
      <Alert role={undefined} variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Primero reasigna a las personas a su cargo</AlertTitle>
        <AlertDescription>
          <p>{name} es jefe directo de estas personas activas; cámbiales el jefe y vuelve a intentarlo:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {impact.activeReports.map((person) => (
              <li key={person.id}>
                <Link to={employeeDetailPath(person.id)} className="font-medium underline underline-offset-4">
                  {person.firstName} {person.lastName}
                </Link>
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }
  if (impact.blocker === "LAST_ACTIVE_HR") {
    return (
      <Alert role={undefined} variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Es la única persona activa de RH</AlertTitle>
        <AlertDescription>Debe quedar al menos una. Da de alta o asigna el rol a otra persona antes.</AlertDescription>
      </Alert>
    );
  }
  if (impact.blocker === "HAS_OVERDUE_PENDING_REQUESTS") {
    return (
      <Alert role={undefined} variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Tiene solicitudes pendientes que ya empezaron</AlertTitle>
        <AlertDescription>
          <p>
            Pudo haber faltado con permiso de palabra, y en la baja los días de vacaciones no disfrutados se pagan
            en el finiquito: su jefe (o RH, si no tiene jefe activo) debe aprobarlas o rechazarlas antes.
          </p>
          <OverdueList employeeId={employee.id} requests={impact.overdueRequests} />
        </AlertDescription>
      </Alert>
    );
  }
  if (impact.blocker !== null) {
    return (
      <Alert role={undefined} variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>No se puede dar de baja</AlertTitle>
        <AlertDescription>
          {impact.blocker === "CANNOT_DEACTIVATE_SELF"
            ? "No puedes darte de baja a ti; pídeselo a otra persona de RH."
            : // A reason this screen does not know yet: never a made-up one.
              "Algo impide darle de baja en este momento. Cierra este aviso y vuelve a intentarlo."}
        </AlertDescription>
      </Alert>
    );
  }

  const { pending, approved } = impact.toCancel;
  const total = pending + approved;
  return (
    <Alert role={undefined}>
      <Info aria-hidden="true" />
      <AlertTitle>
        {total === 0 ? "No se cancelará ninguna solicitud" : `Se cancelarán ${requestsCount(total)}`}
      </AlertTitle>
      <AlertDescription>
        {total > 0 ? (
          <p>
            {pending} {pending === 1 ? "pendiente" : "pendientes"} y {approved}{" "}
            {approved === 1 ? "aprobada" : "aprobadas"} que aún no empiezan. Cada una queda en su historial como
            cancelada por RH.
          </p>
        ) : null}
        {impact.startedApproved > 0 ? (
          <p>
            {requestsCount(impact.startedApproved)} {impact.startedApproved === 1 ? "aprobada que ya empezó no cambia" : "aprobadas que ya empezaron no cambian"}:
            esos días ya se tomaron.
          </p>
        ) : null}
        {impact.approvedRunningPastToday > 0 ? (
          <p>
            {impact.approvedRunningPastToday === 1
              ? "1 de ellas sigue en curso después de hoy: sus días restantes"
              : `${impact.approvedRunningPastToday} de ellas siguen en curso después de hoy: sus días restantes`}{" "}
            se seguirán contando como tomados. Revisa si el finiquito necesita un ajuste de saldo (las vacaciones no
            disfrutadas se pagan).
          </p>
        ) : null}
        <p>Perderá el acceso de inmediato.</p>
      </AlertDescription>
    </Alert>
  );
}

/** Mounted once per opening (`key={session}`), at page level. */
export function DeactivateEmployeeDialog({
  dialog,
  employee,
  onDone,
}: {
  dialog: EntityDialog<EmployeeDetail>;
  employee: EmployeeDetail;
  onDone: (message: string) => void;
}) {
  const impact = useDeactivationImpact(employee.id);
  const deactivate = useDeactivateEmployee(employee.id);
  const impactId = useId();
  const errorOverdue = overdueFromError(deactivate.error);

  let content = null;
  if (impact.isPending) {
    content = <p className="text-sm text-muted-foreground">Revisando sus solicitudes y personas a cargo…</p>;
  } else if (impact.isError) {
    content = (
      <p className="text-sm text-muted-foreground">
        No se pudo revisar qué pasará con sus solicitudes ({impact.error.message}).
      </p>
    );
  } else if (!errorOverdue) {
    content = <ImpactContent employee={employee} impact={impact.data} />;
  }

  const fullName = `${employee.firstName} ${employee.lastName}`;
  return (
    <ConfirmActionDialog
      open={dialog.open}
      setOpen={dialog.setOpen}
      finalFocus={dialog.finalFocus}
      title={`¿Dar de baja a ${fullName}?`}
      description="No podrá iniciar sesión. Su historial y sus solicitudes se conservan; puedes reactivarlo después."
      confirmLabel="Sí, dar de baja"
      pendingLabel="Dando de baja…"
      destructive
      // "Dar de baja" leaves the page with the refresh: focus goes to the h1.
      onRemoved={dialog.markRemoved}
      // Only with a fresh preview that says it can be done (the POST re-checks under its locks).
      canConfirm={impact.isSuccess && impact.data.blocker === null}
      confirmDescribedBy={impactId}
      action={{
        isPending: deactivate.isPending,
        error: deactivate.error,
        run: (callbacks) =>
          deactivate.mutate(employee.updatedAt, {
            onSuccess: (result) => {
              callbacks.onSuccess();
              onDone(
                `${fullName} fue dado de baja.${
                  result.cancelledRequests > 0 ? ` Se ${result.cancelledRequests === 1 ? "canceló" : "cancelaron"} ${requestsCount(result.cancelledRequests)}.` : ""
                }`,
              );
            },
          }),
      }}
    >
      {/* Always mounted: its content arrives after the dialog opened. */}
      <div id={impactId} role="status" className="space-y-2">
        {content}
        {errorOverdue ? (
          // A request became overdue (or was created) after the preview: the 409 lists them.
          <div className="text-sm">
            <p>Estas solicitudes deben decidirse antes de la baja:</p>
            <OverdueList employeeId={employee.id} requests={errorOverdue} />
          </div>
        ) : null}
      </div>
    </ConfirmActionDialog>
  );
}
