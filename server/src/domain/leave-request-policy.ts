/**
 * Pure authorization rules for leave requests.
 *
 * Who decides (approve/reject) a request:
 * - The requester's direct manager, if that manager is active.
 * - Otherwise (no manager, or manager inactive): any active HR user.
 * - Nobody ever decides their own request.
 *
 * Who can see a request: its requester, whoever can decide it, whoever
 * already decided it, and any HR user.
 */

// Mirrors the Prisma Role enum on purpose: src/domain stays free of Prisma
// imports (pure, unit-testable). If Prisma ever gains a role, passing a
// PublicUser as an Actor stops compiling, so the two cannot silently drift.
export type Role = "EMPLOYEE" | "MANAGER" | "HR";

export interface Actor {
  id: string;
  role: Role;
  isActive: boolean;
}

export interface Requester {
  id: string;
  managerId: string | null;
  /** null when the requester has no manager. */
  manager: { isActive: boolean } | null;
}

export function hasActiveManager(requester: Requester): boolean {
  return requester.managerId !== null && requester.manager?.isActive === true;
}

export function canDecide(actor: Actor, requester: Requester): boolean {
  if (!actor.isActive || actor.id === requester.id) {
    return false;
  }
  if (hasActiveManager(requester)) {
    return requester.managerId === actor.id;
  }
  return actor.role === "HR";
}

export function canView(
  actor: Actor,
  request: { requester: Requester; deciderId: string | null },
): boolean {
  return (
    actor.id === request.requester.id ||
    actor.role === "HR" ||
    actor.id === request.deciderId ||
    canDecide(actor, request.requester)
  );
}
