import { useEffect, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { setPasswordChangeRequiredHandler, setUnauthorizedHandler } from "@/api/client";
import { clearSession, refreshSessionAfterPasswordChangeRequired } from "@/auth/session";

interface AppProvidersProps {
  queryClient: QueryClient;
  children: ReactNode;
}

export function AppProviders({ queryClient, children }: AppProvidersProps) {
  // Any 401 from the API (expired session, cookie removed, user deactivated)
  // clears the session; ProtectedRoute then redirects to the login page.
  useEffect(() => setUnauthorizedHandler(() => clearSession(queryClient)), [queryClient]);
  // A 403 PASSWORD_CHANGE_REQUIRED means the cookie now belongs to a
  // temporary-password account (usually another user, from another tab):
  // re-read the session, dropping the cache if the user changed.
  useEffect(
    () => setPasswordChangeRequiredHandler(() => void refreshSessionAfterPasswordChangeRequired(queryClient)),
    [queryClient],
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
