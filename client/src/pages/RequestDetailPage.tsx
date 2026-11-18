import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Ban, CircleCheck, CircleX, FilePlus, Pencil, SearchX, type LucideIcon } from "lucide-react";
import { ApiError } from "@/api/client";
import type { LeaveRequestDetail, Person, RequestEvent, RequestEventAction } from "@/api/types";
import { ROUTES } from "@/app/paths";
import { useCurrentUser } from "@/auth/current-user";
import { useLeaveRequest } from "@/hooks/leave-requests";
import { formatDate, formatDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { CancelRequestDialog } from "@/components/CancelRequestDialog";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { StatusBadge } from "@/components/StatusBadge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const EVENT_STYLES: Record<RequestEventAction, { label: string; icon: LucideIcon; className: string }> = {
  CREATED: { label: "Solicitud creada", icon: FilePlus, className: "bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-300" },
  APPROVED: {
    label: "Aprobada",
    icon: CircleCheck,
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  REJECTED: { label: "Rechazada", icon: CircleX, className: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-300" },
  CANCELLED: { label: "Cancelada", icon: Ban, className: "bg-muted text-neutral-700 dark:text-neutral-300" },
  MODIFIED: { label: "Modificada", icon: Pencil, className: "bg-muted text-neutral-700 dark:text-neutral-300" },
};

function fullName(person: Person): string {
  return `${person.firstName} ${person.lastName}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function Timeline({ events, currentUserId }: { events: RequestEvent[]; currentUserId: string }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin movimientos registrados.</p>;
  }
  return (
    <ol className="relative space-y-6 border-l pl-6" aria-label="Historial de la solicitud">
      {events.map((event) => {
        const { label, icon: Icon, className } = EVENT_STYLES[event.action];
        const actor = event.actor.id === currentUserId ? `${fullName(event.actor)} (tú)` : fullName(event.actor);
        return (
          <li key={event.id} className="relative">
            <span
              className={cn(
                "absolute top-0 -left-[2.3rem] grid size-7 place-items-center rounded-full ring-4 ring-card",
                className,
              )}
              aria-hidden="true"
            >
              <Icon className="size-4" />
            </span>
            <p className="font-medium">{label}</p>
            <p className="text-sm text-muted-foreground">
              {actor} · <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
            </p>
            {event.note ? <p className="mt-1 rounded-lg bg-muted px-3 py-2 text-sm">“{event.note}”</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

function DetailContent({ request }: { request: LeaveRequestDetail }) {
  const user = useCurrentUser();
  const isOwn = request.requester.id === user.id;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            <h2>{request.leaveType.name}</h2>
          </CardTitle>
          <CardAction>
            <StatusBadge status={request.status} />
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-6">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Del">{formatDate(request.startDate)}</Field>
            <Field label="Al">{formatDate(request.endDate)}</Field>
            <Field label="Días hábiles">{request.businessDays}</Field>
            <Field label="Descuenta de tus vacaciones">
              {request.leaveType.countsAgainstVacationBalance ? "Sí" : "No"}
            </Field>
            {!isOwn ? <Field label="Solicitante">{fullName(request.requester)}</Field> : null}
            <Field label="Motivo">{request.reason ?? <span className="text-muted-foreground">Sin motivo</span>}</Field>
            {/* A CANCELLED request with a decider was approved first, then cancelled. */}
            {request.decider ? (
              <Field label={request.status === "REJECTED" ? "Rechazada por" : "Aprobada por"}>
                {fullName(request.decider)}
                {request.decidedAt ? (
                  <span className="block text-sm font-normal text-muted-foreground">
                    <time dateTime={request.decidedAt}>{formatDateTime(request.decidedAt)}</time>
                  </span>
                ) : null}
              </Field>
            ) : null}
            {request.decisionNote ? <Field label="Nota de la decisión">{request.decisionNote}</Field> : null}
          </dl>

          {/* Always mounted: the dialog must survive canCancel turning false while it is open. */}
          <div className={cn(request.permissions.canCancel && "flex justify-end border-t pt-4")}>
            <CancelRequestDialog request={request} canCancel={request.permissions.canCancel} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Historial</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline events={request.events} currentUserId={user.id} />
        </CardContent>
      </Card>
    </div>
  );
}

function NotFound() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <SearchX className="size-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="font-semibold">No encontramos esta solicitud</h2>
          <p className="text-sm text-muted-foreground">Puede que el enlace esté mal o que no tengas acceso a ella.</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function RequestDetailPage() {
  // Always defined: this component is only rendered by the "/solicitudes/:id" route.
  const { id = "" } = useParams();
  const request = useLeaveRequest(id);

  return (
    <>
      <Link to={ROUTES.myRequests} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 -ml-2")}>
        <ArrowLeft aria-hidden="true" />
        Volver a Mis solicitudes
      </Link>
      {/* Rendered in every state, so AppLayout can always move focus to the h1. */}
      <PageHeading title="Detalle de solicitud" />
      {request.isPending ? (
        <LoadingBlock label="Cargando la solicitud…" lines={2} />
      ) : request.isError ? (
        request.error instanceof ApiError && request.error.status === 404 ? (
          <NotFound />
        ) : (
          <QueryError
            title="No se pudo cargar la solicitud"
            error={request.error}
            onRetry={() => void request.refetch()}
            isRetrying={request.isFetching}
          />
        )
      ) : (
        <DetailContent request={request.data} />
      )}
    </>
  );
}
