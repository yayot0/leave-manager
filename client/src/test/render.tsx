import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, type InitialEntry } from "react-router";
import { RouterProvider } from "react-router/dom";
import { AppProviders } from "@/app/AppProviders";
import { createQueryClient } from "@/lib/query-client";
import { routes } from "@/routes/routes";

/**
 * Renders the whole app (real routes, guards and providers) at `initialEntry`,
 * with a memory router and a fresh QueryClient so no cache leaks between tests.
 */
export function renderApp(initialEntry: InitialEntry = "/") {
  const queryClient = createQueryClient();
  // Failed queries are not retried in tests: they would only slow them down.
  queryClient.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });

  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  const user = userEvent.setup();

  const result = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );

  return { ...result, router, user, queryClient };
}
