import { Link } from "react-router";
import { Building2, CalendarX2, ChevronRight, ListChecks, Users, Wallet, type LucideIcon } from "lucide-react";
import { ROUTES } from "@/app/paths";
import { AdminSubnav } from "@/components/admin/AdminSubnav";
import { PageHeading } from "@/components/PageHeading";
import { Card, CardContent } from "@/components/ui/card";

interface Section {
  to: string | null;
  title: string;
  description: string;
  icon: LucideIcon;
}

const SECTIONS: Section[] = [
  {
    to: ROUTES.adminEmployees,
    title: "Empleados",
    description: "Altas, bajas, jefes, roles y contraseñas temporales.",
    icon: Users,
  },
  {
    to: ROUTES.adminDepartments,
    title: "Departamentos",
    description: "Crea y renombra las áreas de la empresa.",
    icon: Building2,
  },
  {
    to: ROUTES.adminLeaveTypes,
    title: "Tipos de permiso",
    description: "Qué pueden pedir los empleados, si descuenta vacaciones y su máximo de días.",
    icon: ListChecks,
  },
  {
    to: ROUTES.adminHolidays,
    title: "Festivos",
    description: "Días de descanso obligatorio que no cuentan como hábiles.",
    icon: CalendarX2,
  },
  { to: null, title: "Ajustes de saldo", description: "Correcciones y días que pasan al siguiente periodo.", icon: Wallet },
];

/** Index of the administration sections (HR only). */
export function AdminPage() {
  return (
    <>
      <PageHeading title="Administración" description="Catálogos y datos de la empresa. Cada cambio queda en la bitácora." />
      <AdminSubnav />
      <ul className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map(({ to, title, description, icon: Icon }) => {
          const content = (
            <CardContent className="flex items-start gap-3">
              <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-1">
                <h2 className="font-semibold">
                  {title}
                  {to ? null : (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                      Próximamente
                    </span>
                  )}
                </h2>
                <p className="text-sm text-muted-foreground">{description}</p>
              </div>
              {to ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
            </CardContent>
          );
          return (
            <li key={title}>
              {to ? (
                <Link
                  to={to}
                  className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Card className="h-full transition-colors hover:bg-muted/50">{content}</Card>
                </Link>
              ) : (
                <Card className="h-full">{content}</Card>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
