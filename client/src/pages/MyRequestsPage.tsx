import { Link } from "react-router";
import { CalendarPlus, Inbox } from "lucide-react";
import type { LeaveRequest } from "@/api/types";
import { requestDetailPath, ROUTES } from "@/app/paths";
import { useMyLeaveRequests } from "@/hooks/leave-requests";
import { formatDateRange, formatShortDate } from "@/lib/dates";
import { formatBusinessDays } from "@/lib/numbers";
import { CancelRequestDialog } from "@/components/CancelRequestDialog";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { StatusBadge } from "@/components/StatusBadge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function rangeOf(request: LeaveRequest): string {
  return formatDateRange(request.startDate, request.endDate, formatShortDate);
}

function DetailLink({ request }: { request: LeaveRequest }) {
  return (
    <Link
      to={requestDetailPath(request.id)}
      className={buttonVariants({ variant: "ghost", size: "sm" })}
      aria-label={`Ver detalle de ${request.leaveType.name}, ${rangeOf(request)}`}
    >
      Ver detalle
    </Link>
  );
}

function RequestActions({ request }: { request: LeaveRequest }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <DetailLink request={request} />
      {/* The API decides whether it can be cancelled (state machine + dates). */}
      <CancelRequestDialog request={request} canCancel={request.permissions.canCancel} size="sm" />
    </div>
  );
}

/** md and up: a table. Hidden with display:none on phones, so it is also out of the accessibility tree there. */
function RequestsTable({ requests }: { requests: LeaveRequest[] }) {
  return (
    <div className="hidden md:block">
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Fechas</TableHead>
              <TableHead scope="col">Tipo</TableHead>
              <TableHead scope="col" className="text-right">
                Días hábiles
              </TableHead>
              <TableHead scope="col">Estado</TableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Acciones</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <TableRow key={request.id}>
                <TableCell className="font-medium">{rangeOf(request)}</TableCell>
                <TableCell>{request.leaveType.name}</TableCell>
                <TableCell className="text-right tabular-nums">{request.businessDays}</TableCell>
                <TableCell>
                  <StatusBadge status={request.status} />
                </TableCell>
                <TableCell>
                  <RequestActions request={request} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

/** Phones: one card per request. */
function RequestCards({ requests }: { requests: LeaveRequest[] }) {
  return (
    <ul className="space-y-3 md:hidden" aria-label="Solicitudes">
      {requests.map((request) => (
        <li key={request.id}>
          <Card size="sm">
            <CardContent className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{request.leaveType.name}</p>
                  <p className="text-sm text-muted-foreground">{rangeOf(request)}</p>
                </div>
                <StatusBadge status={request.status} />
              </div>
              <p className="text-sm">{formatBusinessDays(request.businessDays)}</p>
              <RequestActions request={request} />
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
        <Inbox className="size-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="font-semibold">Aún no tienes solicitudes</h2>
          <p className="text-sm text-muted-foreground">
            Cuando pidas vacaciones o un permiso, aquí podrás ver su estado.
          </p>
        </div>
        <Link to={ROUTES.newRequest} className={buttonVariants()}>
          <CalendarPlus aria-hidden="true" />
          Crear mi primera solicitud
        </Link>
      </CardContent>
    </Card>
  );
}

export function MyRequestsPage() {
  const requests = useMyLeaveRequests();

  return (
    <>
      <PageHeading title="Mis solicitudes" description="Tus solicitudes de vacaciones y permisos." />
      {requests.isPending ? (
        <LoadingBlock label="Cargando tus solicitudes…" />
      ) : requests.isError ? (
        <QueryError
          title="No se pudieron cargar tus solicitudes"
          error={requests.error}
          onRetry={() => void requests.refetch()}
          isRetrying={requests.isFetching}
        />
      ) : requests.data.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="mb-4 flex justify-end">
            <Link to={ROUTES.newRequest} className={buttonVariants({ variant: "outline" })}>
              <CalendarPlus aria-hidden="true" />
              Nueva solicitud
            </Link>
          </div>
          <RequestsTable requests={requests.data} />
          <RequestCards requests={requests.data} />
        </>
      )}
    </>
  );
}
