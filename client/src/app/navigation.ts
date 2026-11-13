import type { ComponentType } from "react";
import { CalendarPlus, ClipboardCheck, FileText, Settings, Wallet, type LucideIcon } from "lucide-react";
import type { Role } from "@/api/types";
import { BalancePage } from "@/pages/BalancePage";
import { MyRequestsPage } from "@/pages/MyRequestsPage";
import { NewRequestPage } from "@/pages/NewRequestPage";
import { ApprovalsPage } from "@/pages/ApprovalsPage";
import { AdminPage } from "@/pages/AdminPage";

import { HOME_ROUTE, ROUTES } from "./paths";

export { HOME_ROUTE, ROUTES };

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
  Component: ComponentType;
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
  { to: ROUTES.approvals, label: "Aprobaciones", icon: ClipboardCheck, roles: ["MANAGER", "HR"], Component: ApprovalsPage },
  { to: ROUTES.admin, label: "Administración", icon: Settings, roles: ["HR"], Component: AdminPage },
];

export function navItemsFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
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
 * with its roles.
 */
export function canAccess(pathname: string, role: Role): boolean {
  const path = normalizePath(pathname);
  const item = NAV_ITEMS.find((navItem) => navItem.to === path);
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
