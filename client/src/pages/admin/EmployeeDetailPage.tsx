import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ArrowLeft, KeyRound, TriangleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import type { EmployeeDetail, PersonWithRole } from "@/api/types";
import { ROLE_LABELS } from "@/app/navigation";
import { employeeDetailPath, employeeListBackPath } from "@/app/paths";
import { useEmployee } from "@/hooks/hr";
import { useEntityDialog } from "@/hooks/use-entity-dialog";
import { formatDate, formatDateRange } from "@/lib/dates";
import { formatDays } from "@/lib/numbers";
import { cn } from "@/lib/utils";
import { ActionStatus } from "@/components/admin/ActionStatus";
import { AdminSubnav } from "@/components/admin/AdminSubnav";
import { DeactivateEmployeeDialog } from "@/components/admin/employees/DeactivateEmployeeDialog";
import { EmployeeFormDialog, type EmployeeFormTarget } from "@/components/admin/employees/EmployeeFormDialog";
import { ReactivateEmployeeDialog, ResetPasswordDialog } from "@/components/admin/employees/EmployeePasswordDialogs";
import { EmployeeStatusBadge } from "@/components/admin/employees/EmployeeStatusBadge";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function PersonLink({ person }: { person: PersonWithRole }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Link to={employeeDetailPath(person.id)} className="font-medium underline underline-offset-4">
        {person.firstName} {person.lastName}
      </Link>
      <span className="text-muted-foreground">{ROLE_LABELS[person.role]}</span>
      {person.isActive ? null : <EmployeeStatusBadge isActive={false} />}
    </span>
  );
}

interface DetailContentProps {
  employee: EmployeeDetail;
  refreshError: Error | null;
  onRetry: () => void;
  isRetrying: boolean;
}

function DetailContent({ employee, refreshError, onRetry, isRetrying }: DetailContentProps) {
  const [status, setStatus] = useState<string | null>(null);
  const formDialog = useEntityDialog<EmployeeFormTarget>();
  const deactivateDialog = useEntityDialog<EmployeeDetail>();
  const resetDialog = useEntityDialog<EmployeeDetail>();
  const reactivateDialog = useEntityDialog<EmployeeDetail>();
  const { permissions, balance } = employee;
  // Stale data (a refresh failed): show it, but offer no action on it.
  const actionsEnabled = refreshError === null;

  return (
    <>
      <ActionStatus message={status} />
      {refreshError ? (
        <Alert role={undefined} className="mb-4">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Estos datos pueden estar desactualizados</AlertTitle>
          <AlertDescription>
            <p>No se pudieron volver a cargar ({refreshError.message}). Mientras tanto no se ofrece ninguna acción.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={onRetry} disabled={isRetrying}>
              {isRetrying ? "Reintentando…" : "Reintentar"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <EmployeeStatusBadge isActive={employee.isActive} />
        {employee.mustChangePassword && employee.isActive ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
            <KeyRound className="size-3.5" aria-hidden="true" />
            Con contraseña temporal
          </span>
        ) : null}
      </div>

      {actionsEnabled ? (
        <div className="mb-6 flex flex-wrap gap-2">
          <Button aria-haspopup="dialog" onClick={() => formDialog.show({ employee })}>
            Editar datos
          </Button>
          {permissions.canResetPassword ? (
            <Button variant="outline" aria-haspopup="dialog" onClick={() => resetDialog.show(employee)}>
              Restablecer contraseña
            </Button>
          ) : null}
          {permissions.canDeactivate ? (
            <Button variant="outline" aria-haspopup="dialog" onClick={() => deactivateDialog.show(employee)}>
              Dar de baja
            </Button>
          ) : null}
          {permissions.canReactivate ? (
            <Button variant="outline" aria-haspopup="dialog" onClick={() => reactivateDialog.show(employee)}>
              Reactivar
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Datos</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Correo</dt>
              <dd className="break-all">{employee.email}</dd>
              <dt className="text-muted-foreground">Rol</dt>
              <dd>{ROLE_LABELS[employee.role]}</dd>
              <dt className="text-muted-foreground">Departamento</dt>
              <dd>{employee.department?.name ?? "Sin departamento"}</dd>
              <dt className="text-muted-foreground">Fecha de ingreso</dt>
              <dd>{formatDate(employee.hireDate)}</dd>
              <dt className="text-muted-foreground">Jefe directo</dt>
              <dd>{employee.manager ? <PersonLink person={employee.manager} /> : "Sin jefe (decide RH)"}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Saldo de vacaciones</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-2xl font-semibold tabular-nums">{formatDays(balance.available)}</span>{" "}
              <span className="text-muted-foreground">disponibles</span>
            </p>
            <p className="text-muted-foreground">
              Periodo {formatDateRange(balance.period.start, balance.period.end)} · {balance.yearsOfService}{" "}
              {balance.yearsOfService === 1 ? "año" : "años"} de antigüedad · {formatDays(balance.earned)} ganados ·{" "}
              {formatDays(balance.approved)} aprobados · {formatDays(balance.pending)} pendientes
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>
              <h2>Personas a su cargo</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {employee.directReports.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nadie le reporta directamente.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {employee.directReports.map((person) => (
                  <li key={person.id}>
                    <PersonLink person={person} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Page-level dialogs (see useEntityDialog). */}
      {formDialog.target ? (
        <EmployeeFormDialog
          key={formDialog.session}
          dialog={formDialog}
          employee={formDialog.target.employee}
          onDone={setStatus}
        />
      ) : null}
      {deactivateDialog.target ? (
        <DeactivateEmployeeDialog
          key={deactivateDialog.session}
          dialog={deactivateDialog}
          employee={deactivateDialog.target}
          onDone={setStatus}
        />
      ) : null}
      {resetDialog.target ? (
        <ResetPasswordDialog
          key={resetDialog.session}
          dialog={resetDialog}
          employee={resetDialog.target}
          onDone={setStatus}
        />
      ) : null}
      {reactivateDialog.target ? (
        <ReactivateEmployeeDialog
          key={reactivateDialog.session}
          dialog={reactivateDialog}
          employee={reactivateDialog.target}
          onDone={setStatus}
        />
      ) : null}
    </>
  );
}

function NotFound() {
  return (
    <Card>
      <CardContent className="py-6 text-sm">
        Este empleado no existe. Puede que el enlace esté mal escrito.
      </CardContent>
    </Card>
  );
}

export function EmployeeDetailPage() {
  // Always defined: only rendered by the "/administracion/empleados/:id" route.
  const { id = "" } = useParams();
  const location = useLocation();
  const employee = useEmployee(id);
  const title = employee.data ? `${employee.data.firstName} ${employee.data.lastName}` : "Detalle de empleado";

  return (
    <>
      <Link
        to={employeeListBackPath(location.state)}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 -ml-2")}
      >
        <ArrowLeft aria-hidden="true" />
        Volver a Empleados
      </Link>
      {/* Rendered in every state, so AppLayout can always move focus to the h1. */}
      <PageHeading title={title} />
      <AdminSubnav />
      {employee.data ? (
        // Data first: a failed refresh must not unmount the dialog showing an error.
        <DetailContent
          key={employee.data.id}
          employee={employee.data}
          refreshError={employee.isError ? employee.error : null}
          onRetry={() => void employee.refetch()}
          isRetrying={employee.isFetching}
        />
      ) : employee.isPending ? (
        <LoadingBlock label="Cargando al empleado…" lines={2} />
      ) : employee.error instanceof ApiError && employee.error.status === 404 ? (
        <NotFound />
      ) : (
        <QueryError
          title="No se pudo cargar al empleado"
          error={employee.error}
          onRetry={() => void employee.refetch()}
          isRetrying={employee.isFetching}
        />
      )}
    </>
  );
}
