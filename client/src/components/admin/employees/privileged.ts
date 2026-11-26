import type { Role } from "@/api/types";

const PRIVILEGED: ReadonlySet<Role> = new Set(["MANAGER", "HR"]);

/** What someone holding the temporary password could do in that person's name. */
export function powersOf(role: Role): string {
  return role === "HR" ? "administrar empleados y saldos" : "aprobar o rechazar solicitudes de su equipo";
}

/**
 * The stronger warning for accounts that can approve or administer (risk of
 * impersonation, see CLAUDE.md): a checkbox HR must tick before confirming.
 * Also used when creating such an account.
 */
export function privilegedAcknowledgement(role: Role, firstName: string): string | undefined {
  return PRIVILEGED.has(role)
    ? `Entiendo que, con esta contraseña, quien la use podría ${powersOf(role)} en nombre de ${firstName}, y que se la entregaré solo a esa persona.`
    : undefined;
}

export function isPrivilegedRole(role: Role): boolean {
  return PRIVILEGED.has(role);
}
