/**
 * URL paths of the app. Kept apart from navigation.ts (which imports every
 * page) so non-UI code, like the session hooks, can use them.
 */
export const ROUTES = {
  login: "/login",
  balance: "/saldo",
  myRequests: "/solicitudes",
  newRequest: "/solicitudes/nueva",
  requestDetail: "/solicitudes/:id",
  approvals: "/aprobaciones",
  admin: "/administracion",
} as const;

export const HOME_ROUTE = ROUTES.balance;

/** Path of a request's detail page; the id is escaped like any URL segment. */
export function requestDetailPath(id: string): string {
  return `/solicitudes/${encodeURIComponent(id)}`;
}

/**
 * Router state a link passes when it opens a detail from Aprobaciones, so the
 * detail's "Volver" goes back there. Only this literal value is recognized:
 * the state never becomes a URL, so it cannot redirect anywhere else.
 */
export const FROM_APPROVALS_STATE = { from: "approvals" } as const;

export function cameFromApprovals(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as { from?: unknown }).from === "approvals";
}
