import type { ReactNode } from "react";
import { Link } from "react-router";
import { CalendarPlus, TriangleAlert } from "lucide-react";
import type { VacationBalance } from "@/api/types";
import { ROUTES } from "@/app/paths";
import { useBalance } from "@/hooks/leave-requests";
import { formatDate, nextDateOnly } from "@/lib/dates";
import { formatDays, formatNumber, formatSigned } from "@/lib/numbers";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function years(count: number): string {
  return `${count} ${count === 1 ? "año" : "años"}`;
}

interface BreakdownRowProps {
  label: string;
  value: string;
  children: ReactNode;
}

function BreakdownRow({ label, value, children }: BreakdownRowProps) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 py-3">
      <dt className="font-medium">{label}</dt>
      <dd className="text-right font-semibold tabular-nums">{value}</dd>
      <dd className="col-span-2 text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}

function BalanceDetails({ balance }: { balance: VacationBalance }) {
  const { earned, adjustments, approved, pending, available, yearsOfService, period } = balance;
  const firstYear = yearsOfService === 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Días disponibles</h2>
          </CardTitle>
          <CardDescription>
            Periodo del {formatDate(period.start)} al {formatDate(period.end)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="flex items-baseline gap-2">
            <span className="text-5xl font-bold tabular-nums tracking-tight">{formatNumber(available)}</span>
            <span className="text-lg text-muted-foreground">{Math.abs(available) === 1 ? "día" : "días"}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {years(yearsOfService)} de servicio · calculado al {formatDate(balance.asOf)}
          </p>
          {available > 0 ? (
            <Link to={ROUTES.newRequest} className={buttonVariants()}>
              <CalendarPlus aria-hidden="true" />
              Pedir vacaciones
            </Link>
          ) : null}
        </CardContent>
      </Card>

      {available < 0 ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Tu saldo está en negativo</AlertTitle>
          <AlertDescription>
            Recursos Humanos hizo un ajuste que dejó tu saldo por debajo de lo que ya tenías apartado. Mientras siga
            así, tus solicitudes pendientes de este periodo no se pueden aprobar. Habla con Recursos Humanos.
          </AlertDescription>
        </Alert>
      ) : null}

      {firstYear ? (
        // Information, not an error: role="note" so it is not announced as urgent.
        <Alert role="note">
          <AlertTitle>Aún estás en tu primer año</AlertTitle>
          <AlertDescription>
            La Ley Federal del Trabajo da vacaciones al cumplir cada año de servicio. Tus primeros días llegan en tu
            primer aniversario, el {formatDate(nextDateOnly(period.end))}.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>¿De dónde sale este número?</h2>
          </CardTitle>
          <CardDescription>
            Ganados por antigüedad + ajustes − aprobados − pendientes = disponibles.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <BreakdownRow label="Ganados por antigüedad" value={formatSigned(earned)}>
              {firstYear
                ? "Todavía no cumples tu primer año, así que aún no ganas días."
                : `Con ${years(yearsOfService)} de servicio, la Ley Federal del Trabajo te da ${formatDays(earned)} en este periodo.`}
            </BreakdownRow>
            <BreakdownRow label="Ajustes de Recursos Humanos" value={formatSigned(adjustments)}>
              {adjustments === 0
                ? "No hay ajustes en este periodo."
                : "Días que Recursos Humanos sumó o restó a mano, por ejemplo los que te pasaron de tu periodo anterior."}
            </BreakdownRow>
            <BreakdownRow label="Aprobados" value={formatSigned(-approved)}>
              Días hábiles de tus solicitudes ya aprobadas que empiezan en este periodo.
            </BreakdownRow>
            <BreakdownRow label="Pendientes" value={formatSigned(-pending)}>
              Días hábiles de solicitudes que esperan respuesta. Se apartan mientras se deciden; si te rechazan o
              cancelas una, regresan a tu saldo.
            </BreakdownRow>
            <div className="grid grid-cols-[1fr_auto] gap-x-4 pt-3">
              <dt className="font-semibold">Disponibles</dt>
              <dd className="text-right text-lg font-bold tabular-nums">{formatNumber(available)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">
            Solo cuentan días hábiles: no se descuentan sábados, domingos ni festivos. Los días que no uses no pasan
            solos al siguiente periodo: el saldo empieza de nuevo en cada aniversario.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function BalancePage() {
  const balance = useBalance();

  return (
    <>
      <PageHeading title="Mi saldo" description="Días de vacaciones disponibles en tu periodo actual." />
      {balance.isPending ? (
        <LoadingBlock label="Cargando tu saldo…" />
      ) : balance.isError ? (
        <QueryError
          title="No se pudo cargar tu saldo"
          error={balance.error}
          onRetry={() => void balance.refetch()}
          isRetrying={balance.isFetching}
        />
      ) : (
        <BalanceDetails balance={balance.data} />
      )}
    </>
  );
}
