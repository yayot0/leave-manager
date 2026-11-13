/**
 * URL paths of the app. Kept apart from navigation.ts (which imports every
 * page) so non-UI code, like the session hooks, can use them.
 */
export const ROUTES = {
  login: "/login",
  balance: "/saldo",
  myRequests: "/solicitudes",
  newRequest: "/solicitudes/nueva",
  approvals: "/aprobaciones",
  admin: "/administracion",
} as const;

export const HOME_ROUTE = ROUTES.balance;
