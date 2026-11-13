import { Navigate, type RouteObject } from "react-router";
import { HOME_ROUTE, NAV_ITEMS, ROUTES } from "@/app/navigation";
import { AppLayout } from "@/layout/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { ProtectedRoute, PublicOnlyRoute, RoleRoute } from "./guards";
import { RouteErrorPage } from "./RouteErrorPage";

/**
 * Route tree, shared by the browser router (main.tsx) and the memory router
 * used in tests, so tests exercise the real routes.
 */
export const routes: RouteObject[] = [
  {
    errorElement: <RouteErrorPage />,
    children: [
      {
        path: ROUTES.login,
        element: (
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        ),
      },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <AppLayout />,
            children: [
              { index: true, element: <Navigate to={HOME_ROUTE} replace /> },
              ...NAV_ITEMS.map(({ to, roles, Component }) => ({
                path: to,
                element: (
                  <RoleRoute roles={roles}>
                    <Component />
                  </RoleRoute>
                ),
              })),
              { path: "*", element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];
