import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import type { Role } from "@/api/types";
import { useSession } from "@/auth/session";
import { CurrentUserContext, useCurrentUser } from "@/auth/current-user";
import { FullPageError, FullPageLoading } from "@/components/FullPageStatus";
import { ROUTES } from "@/app/navigation";
import { ForbiddenPage } from "@/pages/ForbiddenPage";
import { redirectTarget, type LoginLocationState } from "./redirect-target";

/** Renders its child routes only with a session; otherwise goes to login. */
export function ProtectedRoute() {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) {
    return <FullPageLoading label="Cargando sesión…" />;
  }

  // Only when there is no user yet. If a background refetch of /me fails
  // (network blip on window focus), TanStack Query keeps the previous user in
  // `data`: keep the app on screen instead of unmounting the page.
  if (session.isError && session.data === undefined) {
    return (
      <FullPageError
        title="No se pudo cargar tu sesión"
        message={session.error.message}
        onRetry={() => void session.refetch()}
      />
    );
  }

  if (!session.data) {
    const state: LoginLocationState = { from: location.pathname + location.search };
    return <Navigate to={ROUTES.login} replace state={state} />;
  }

  return (
    <CurrentUserContext value={session.data}>
      <Outlet />
    </CurrentUserContext>
  );
}

/**
 * For pages without a session (login). As soon as there is a user (already
 * logged in, or the login just succeeded) it redirects into the app; this is
 * the only place that decides where to go after login.
 */
export function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) {
    return <FullPageLoading />;
  }

  // If /me fails (e.g. API down), still show the login form: logging in will
  // report the connection problem.
  if (session.data) {
    return <Navigate to={redirectTarget(location.state, session.data.role)} replace />;
  }

  return children;
}

interface RoleRouteProps {
  roles: readonly Role[];
  children: ReactNode;
}

/**
 * Shows the page only to the given roles. This is UX, not security: the API
 * enforces the same rules on every endpoint.
 */
export function RoleRoute({ roles, children }: RoleRouteProps) {
  const user = useCurrentUser();
  return roles.includes(user.role) ? children : <ForbiddenPage />;
}
