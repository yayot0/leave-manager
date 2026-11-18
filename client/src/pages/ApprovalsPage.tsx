import { Link } from "react-router";
import { CalendarClock, Inbox } from "lucide-react";
import type { PendingApproval, Person } from "@/api/types";
import { FROM_APPROVALS_STATE, requestDetailPath } from "@/app/paths";
import { useCurrentUser } from "@/auth/current-user";
import { usePendingApprovals } from "@/hooks/leave-requests";
import { formatDateRange, formatShortDate } from "@/lib/dates";
import { formatBusinessDays } from "@/lib/numbers";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function fullName(person: Person): string {
  return `${person.firstName} ${person.lastName}`;
}

function rangeOf(request: PendingApproval): string {
  return formatDateRange(request.startDate, request.endDate, formatShortDate);
}

/** Text and icon, so it never depends on color alone (WCAG 1.4.1). */
function OverdueBadge() {
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
      <CalendarClock className="size-3.5" aria-hidden="true" />
      Vencida
    </span>
  );
}

function ReviewLink({ request }: { request: PendingApproval }) {
  return (
    <Link
      to={requestDetailPath(request.id)}
      // So the detail's "Volver" comes back here.
      state={FROM_APPROVALS_STATE}
      className={buttonVariants({ variant: "outline", size: "sm" })}
      // Several "Revisar" links share the page: the name says which request.
      aria-label={`Revisar solicitud de ${fullName(request.requester)}: ${request.leaveType.name}, ${rangeOf(request)}`}
    >
      Revisar
    </Link>
  );
}

/** md and up: a table. Hidden with display:none on phones, so it is also out of the accessibility tree there. */
function ApprovalsTable({ requests }: { requests: PendingApproval[] }) {
  return (
    <div className="hidden md:block">
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Solicitante</TableHead>
              <TableHead scope="col">Tipo</TableHead>
              <TableHead scope="col">Fechas</TableHead>
              <TableHead scope="col" className="text-right">
                Días hábiles
              </TableHead>
              <TableHead scope="col">Aviso</TableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Acciones</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <TableRow key={request.id}>
                <TableCell className="font-medium">{fullName(request.requester)}</TableCell>
                <TableCell>{request.leaveType.name}</TableCell>
                <TableCell>{rangeOf(request)}</TableCell>
                <TableCell className="text-right tabular-nums">{request.businessDays}</TableCell>
                <TableCell>{request.isOverdue ? <OverdueBadge /> : null}</TableCell>
                <TableCell className="text-right">
                  <ReviewLink request={request} />
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
function ApprovalCards({ requests }: { requests: PendingApproval[] }) {
  return (
    <ul className="space-y-3 md:hidden" aria-label="Solicitudes por revisar">
      {requests.map((request) => (
        <li key={request.id}>
          <Card size="sm">
            <CardContent className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{fullName(request.requester)}</p>
                  <p className="text-sm text-muted-foreground">
                    {request.leaveType.name} · {rangeOf(request)}
                  </p>
                </div>
                {request.isOverdue ? <OverdueBadge /> : null}
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm">{formatBusinessDays(request.businessDays)}</p>
                <ReviewLink request={request} />
              </div>
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
          <h2 className="font-semibold">No tienes solicitudes por revisar</h2>
          <p className="text-sm text-muted-foreground">Cuando alguien te pida vacaciones o un permiso, aparecerá aquí.</p>
        </div>
      </CardContent>
    </Card>
  );
}

function OverdueSummary({ count }: { count: number }) {
  if (count === 0) {
    return null;
  }
  return (
    <p className="mb-4 flex items-center gap-2 text-sm">
      <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
      {count === 1
        ? "1 solicitud ya empezó y sigue pendiente; aparece primero."
        : `${count} solicitudes ya empezaron y siguen pendientes; aparecen primero.`}
    </p>
  );
}

export function ApprovalsPage() {
  const user = useCurrentUser();
  const requests = usePendingApprovals();

  return (
    <>
      <PageHeading
        title="Aprobaciones"
        description={
          user.role === "HR"
            ? "Solicitudes de tu equipo y de quienes no tienen un jefe activo, en espera de tu decisión."
            : "Solicitudes de tu equipo en espera de tu decisión."
        }
      />
      {requests.isPending ? (
        <LoadingBlock label="Cargando solicitudes por revisar…" />
      ) : requests.isError ? (
        <QueryError
          title="No se pudieron cargar las solicitudes por revisar"
          error={requests.error}
          onRetry={() => void requests.refetch()}
          isRetrying={requests.isFetching}
        />
      ) : requests.data.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* The API already sorts by start date, so the overdue ones come first. */}
          <OverdueSummary count={requests.data.filter((request) => request.isOverdue).length} />
          <ApprovalsTable requests={requests.data} />
          <ApprovalCards requests={requests.data} />
        </>
      )}
    </>
  );
}
