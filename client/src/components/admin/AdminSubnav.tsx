import { NavLink } from "react-router";
import { ROUTES } from "@/app/paths";
import { cn } from "@/lib/utils";

const SECTIONS = [
  // Not "Inicio": that would read as the app's home (Mi saldo).
  { to: ROUTES.admin, label: "Resumen" },
  { to: ROUTES.adminDepartments, label: "Departamentos" },
  { to: ROUTES.adminLeaveTypes, label: "Tipos de permiso" },
  { to: ROUTES.adminHolidays, label: "Festivos" },
] as const;

/**
 * Links between the administration sections. NavLink sets
 * aria-current="page" on the current one, so it is announced, not only
 * shown in another color.
 */
export function AdminSubnav() {
  return (
    <nav aria-label="Secciones de administración" className="mb-6 -mt-2 overflow-x-auto">
      <ul className="flex gap-1 border-b">
        {SECTIONS.map(({ to, label }) => (
          <li key={to}>
            <NavLink
              to={to}
              end
              className={({ isActive }) =>
                cn(
                  "-mb-px inline-block border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )
              }
            >
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
