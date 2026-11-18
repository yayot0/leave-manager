import { useId, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  ArrowLeft,
  Ban,
  CalendarClock,
  CircleCheck,
  CircleX,
  FilePlus,
  Pencil,
  SearchX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { ApiError } from "@/api/client";
import type { LeaveRequestDetail, Person, RequestEvent, RequestEventAction, RequesterBalance } from "@/api/types";
import { canAccess, ROUTES } from "@/app/navigation";
import { cameFromApprovals } from "@/app/paths";
import { useCurrentUser } from "@/auth/current-user";
import { useLeaveRequest } from "@/hooks/leave-requests";
import { formatDate, formatDateRange, formatDateTime } from "@/lib/dates";
import { formatDays } from "@/lib/numbers";
import { cn } from "@/lib/utils";
import { CancelRequestDialog } from "@/components/CancelRequestDialog";
import { DecisionDialog, type Decision } from "@/components/DecisionDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

const DECIDED_MESSAGES: Record<Decision, string> = {
  approve: "Aprobaste la solicitud. El empleado ya puede verla como aprobada.",
  reject: "Rechazaste la solicitud. El empleado verá el motivo que escribiste.",
};

/** What the decider needs before approving: the requester's balance in the request's period. */
function RequesterBalanceSummary({ balance, requester }: { balance: RequesterBalance; requester: Person }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-lg border p-4">
      <div className="space-y-0.5">
        <h3 id={headingId} className="font-medium">
          Saldo de vacaciones de {fullName(requester)}
        </h3>
        <p className="text-sm text-muted-foreground">
          Periodo del {formatDateRange(balance.period.start, balance.period.end)}
        </p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Field label="Disponibles sin esta solicitud">{formatDays(balance.availableWithoutRequest)}</Field>
        <Field label="Si la apruebas, le quedan">{formatDays(balance.availableAfterApproval)}</Field>
      </dl>
      {/* Static warnings use role={undefined}: role="alert" is for messages that appear after an action. */}
      {balance.blocksApproval ? (
        <Alert variant="destructive" role={undefined}>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>El saldo de este periodo ya es negativo</AlertTitle>
          <AlertDescription>
            Ninguna solicitud de vacaciones de este periodo se puede aprobar hasta que se rechace o cancele alguna, o
            RH corrija el saldo. Puedes rechazarla.
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

const NO_PERMISSIONS: LeaveRequestDetail["permissions"] = { canApprove: false, canReject: false, canCancel: false };

/**
 * Shown when a refresh failed but the last good data is still on screen
 * (e.g. after a decision error the request is no longer visible: 404).
 */
function RefreshError({ error, onRetry, isRetrying }: { error: Error; onRetry: () => void; isRetrying: boolean }) {
  const lostAccess = error instanceof ApiError && error.status === 404;
  return (
    <Alert variant="destructive" role={undefined}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{lostAccess ? "Ya no tienes acceso a esta solicitud" : "No se pudo actualizar la solicitud"}</AlertTitle>
      <AlertDescription>
        <p>
          {lostAccess
            ? "Puede que el empleado haya cambiado de jefe o que la solicitud ya no exista. Abajo ves cómo estaba la última vez que la cargaste."
            : `${error.message} Abajo ves cómo estaba la última vez que la cargaste.`}
        </p>
        {lostAccess ? null : (
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry} disabled={isRetrying}>
            {isRetrying ? "Reintentando…" : "Reintentar"}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

interface DetailContentProps {
  request: LeaveRequestDetail;
  /** A refresh failed: the data is outdated, so no action is offered. */
  refreshError: Error | null;
  onRetry: () => void;
  isRetrying: boolean;
}

function DetailContent({ request, refreshError, onRetry, isRetrying }: DetailContentProps) {
  const user = useCurrentUser();
  const isOwn = request.requester.id === user.id;
  // Outdated data never offers actions; the dialogs already open stay mounted anyway.
  const { canApprove, canReject, canCancel } = refreshError ? NO_PERMISSIONS : request.permissions;
  const canDecide = canApprove || canReject;
  // The API says whether approving would fail for lack of balance; never recomputed here.
  const approveAllowed = canApprove && !request.requesterBalance?.blocksApproval;
  const [decided, setDecided] = useState<Decision | null>(null);

  return (
    <div className="space-y-6">
      {/*
        Live region always mounted (empty until a decision): screen readers
        announce content added to an existing region, not a region that
        appears already filled.
      */}
      <div role="status">
        {decided ? (
          <Alert role={undefined}>
            <CircleCheck aria-hidden="true" />
            <AlertDescription>{DECIDED_MESSAGES[decided]}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      {refreshError ? <RefreshError error={refreshError} onRetry={onRetry} isRetrying={isRetrying} /> : null}

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
          {canDecide && request.isOverdue ? (
            <Alert role={undefined}>
              <CalendarClock aria-hidden="true" />
              <AlertTitle>Vencida: ya empezó y sigue pendiente</AlertTitle>
              <AlertDescription>
                Empezaba el {formatDate(request.startDate)}. Todavía puedes decidirla; apruébala solo si esas fechas
                ya estaban autorizadas.
              </AlertDescription>
            </Alert>
          ) : null}

          <dl className="grid gap-4 sm:grid-cols-2">
            {!isOwn ? <Field label="Solicitante">{fullName(request.requester)}</Field> : null}
            <Field label="Del">{formatDate(request.startDate)}</Field>
            <Field label="Al">{formatDate(request.endDate)}</Field>
            <Field label="Días hábiles">{request.businessDays}</Field>
            <Field label={isOwn ? "Descuenta de tus vacaciones" : "Descuenta de sus vacaciones"}>
              {request.leaveType.countsAgainstVacationBalance ? "Sí" : "No"}
            </Field>
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

          {canDecide && request.requesterBalance ? (
            <RequesterBalanceSummary balance={request.requesterBalance} requester={request.requester} />
          ) : null}

          {/*
            Always mounted: each dialog must survive its permission turning
            false while it is open (success, or a refresh after an error).
          */}
          <div className={cn((canCancel || canDecide) && "flex flex-wrap justify-end gap-2 border-t pt-4")}>
            <CancelRequestDialog request={request} canCancel={canCancel} />
            <DecisionDialog decision="reject" request={request} allowed={canReject} onDecided={setDecided} />
            <DecisionDialog decision="approve" request={request} allowed={approveAllowed} onDecided={setDecided} />
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

/**
 * Where "Volver" goes: Aprobaciones when the detail was opened from there,
 * or when someone else's request is on screen (a decider or HR, who reach
 * it from Aprobaciones); Mis solicitudes otherwise. Only for roles that can
 * open Aprobaciones.
 */
function useBackLink(request: LeaveRequestDetail | undefined): { to: string; label: string } {
  const user = useCurrentUser();
  const location = useLocation();
  const othersRequest = request !== undefined && request.requester.id !== user.id;
  if ((cameFromApprovals(location.state) || othersRequest) && canAccess(ROUTES.approvals, user.role)) {
    return { to: ROUTES.approvals, label: "Volver a Aprobaciones" };
  }
  return { to: ROUTES.myRequests, label: "Volver a Mis solicitudes" };
}

export function RequestDetailPage() {
  // Always defined: this component is only rendered by the "/solicitudes/:id" route.
  const { id = "" } = useParams();
  const request = useLeaveRequest(id);
  const back = useBackLink(request.data);

  return (
    <>
      <Link to={back.to} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 -ml-2")}>
        <ArrowLeft aria-hidden="true" />
        {back.label}
      </Link>
      {/* Rendered in every state, so AppLayout can always move focus to the h1. */}
      <PageHeading title="Detalle de solicitud" />
      {request.data ? (
        // Data first: a failed refresh (e.g. after a decision error) must not
        // unmount the detail and the dialog that is showing that error.
        <DetailContent
          // A different request starts fresh (success message, dialogs).
          key={request.data.id}
          request={request.data}
          refreshError={request.isError ? request.error : null}
          onRetry={() => void request.refetch()}
          isRetrying={request.isFetching}
        />
      ) : request.isPending ? (
        <LoadingBlock label="Cargando la solicitud…" lines={2} />
      ) : (
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
      )}
    </>
  );
}
