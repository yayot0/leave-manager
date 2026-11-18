import type { ComponentType } from "react";
import { matchPath } from "react-router";
import { CalendarPlus, ClipboardCheck, FileText, Settings, Wallet, type LucideIcon } from "lucide-react";
import type { Role } from "@/api/types";
import { BalancePage } from "@/pages/BalancePage";
import { MyRequestsPage } from "@/pages/MyRequestsPage";
import { NewRequestPage } from "@/pages/NewRequestPage";
import { ApprovalsPage } from "@/pages/ApprovalsPage";
import { AdminPage } from "@/pages/AdminPage";
import { RequestDetailPage } from "@/pages/RequestDetailPage";

import { HOME_ROUTE, requestDetailPath, ROUTES } from "./paths";

export { HOME_ROUTE, requestDetailPath, ROUTES };

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
  Component: ComponentType;
  /** false for pages reached from inside another page (e.g. a detail). */
  showInMenu?: boolean;
}

const ALL_ROLES: readonly Role[] = ["EMPLOYEE", "MANAGER", "HR"];

/**
 * Single source of truth for the app sections: the menu and the protected
 * routes are both built from this list, so a role never sees a menu entry it
 * cannot open (or a page missing from its menu).
 *
 * HR also sees "Aprobaciones": HR decides requests when the requester has no
 * active manager (see CLAUDE.md).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: ROUTES.balance, label: "Mi saldo", icon: Wallet, roles: ALL_ROLES, Component: BalancePage },
  { to: ROUTES.myRequests, label: "Mis solicitudes", icon: FileText, roles: ALL_ROLES, Component: MyRequestsPage },
  { to: ROUTES.newRequest, label: "Nueva solicitud", icon: CalendarPlus, roles: ALL_ROLES, Component: NewRequestPage },
  // Any role can open a detail: the API answers 404 for requests the user may
  // not see (see "Ver el detalle" in CLAUDE.md).
  {
    to: ROUTES.requestDetail,
    label: "Detalle de solicitud",
    icon: FileText,
    roles: ALL_ROLES,
    Component: RequestDetailPage,
    showInMenu: false,
  },
  { to: ROUTES.approvals, label: "Aprobaciones", icon: ClipboardCheck, roles: ["MANAGER", "HR"], Component: ApprovalsPage },
  { to: ROUTES.admin, label: "Administración", icon: Settings, roles: ["HR"], Component: AdminPage },
];

export function navItemsFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.showInMenu !== false && item.roles.includes(role));
}

/**
 * Normalizes a pathname the way React Router matches it: case-insensitive and
 * ignoring trailing slashes ("/Aprobaciones/" → "/aprobaciones").
 */
export function normalizePath(pathname: string): string {
  return pathname.toLowerCase().replace(/\/+$/, "") || "/";
}

/**
 * Whether `role` may open `pathname`. Default deny: a path that is not a known
 * section returns false, so a new route is closed until it is added here
 * with its roles. Patterns like "/solicitudes/:id" are matched with React
 * Router's own `matchPath` (one segment per param, case-insensitive), so this
 * agrees with what the router would render.
 */
export function canAccess(pathname: string, role: Role): boolean {
  const path = normalizePath(pathname);
  // Static paths first, as the router ranks them: "/solicitudes/nueva" is
  // the new-request page, not a detail with id "nueva".
  const item =
    NAV_ITEMS.find((navItem) => navItem.to === path) ??
    NAV_ITEMS.find((navItem) => matchPath({ path: navItem.to, end: true }, path) !== null);
  return item !== undefined && item.roles.includes(role);
}

/** Menu label of the home page, for "Ir a …" links. */
export function homeLabel(): string {
  return NAV_ITEMS.find((item) => item.to === HOME_ROUTE)?.label ?? "Inicio";
}

export const ROLE_LABELS: Record<Role, string> = {
  EMPLOYEE: "Empleado",
  MANAGER: "Jefe de área",
  HR: "Recursos Humanos",
};
