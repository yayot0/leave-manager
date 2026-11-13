import { hashKey, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { getMe, login, logout } from "@/api/auth";
import type { User } from "@/api/types";
import { ROUTES } from "@/app/paths";

export const sessionQueryKey = ["auth", "me"] as const;
const sessionQueryHash = hashKey(sessionQueryKey);

/** Session state: `data` is the user, or `null` when nobody is logged in. */
export function useSession() {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Forgets the session on the client: the session becomes `null` (so
 * `ProtectedRoute` sends the user to login) and every other cached query and
 * mutation is dropped, so the next user never sees the previous user's data.
 */
export function clearSession(queryClient: QueryClient): void {
  setSession(queryClient, null);
}

function setSession(queryClient: QueryClient, user: User | null): void {
  // Exact key match: any other query (even another one under "auth") is
  // user data and must go.
  const isOtherQuery = (query: { queryHash: string }) => query.queryHash !== sessionQueryHash;
  // Cancel in-flight fetches first, so a late response cannot recreate a
  // query with the previous user's data after it was removed.
  void queryClient.cancelQueries({ predicate: isOtherQuery });
  queryClient.removeQueries({ predicate: isOtherQuery });
  // Mutations keep their variables (login password, request notes…) in memory.
  queryClient.getMutationCache().clear();
  queryClient.setQueryData(sessionQueryKey, user);
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: login,
    // Drops anything cached from a previous session before storing the new user.
    onSuccess: (user) => setSession(queryClient, user),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      // Navigate first, without `from`: a deliberate logout should not send
      // the next person who logs in to the previous user's page (`from` is
      // only for an expired session). Both calls run synchronously, so React
      // renders /login once with the session already null.
      void navigate(ROUTES.login, { replace: true });
      clearSession(queryClient);
    },
  });
}
