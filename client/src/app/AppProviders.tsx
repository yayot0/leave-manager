import { useEffect, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "@/api/client";
import { clearSession } from "@/auth/session";

interface AppProvidersProps {
  queryClient: QueryClient;
  children: ReactNode;
}

export function AppProviders({ queryClient, children }: AppProvidersProps) {
  // Any 401 from the API (expired session, cookie removed, user deactivated)
  // clears the session; ProtectedRoute then redirects to the login page.
  useEffect(() => setUnauthorizedHandler(() => clearSession(queryClient)), [queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
