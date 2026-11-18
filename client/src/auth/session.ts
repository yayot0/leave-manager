import { hashKey, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getMe, login, logout } from "@/api/auth";
import type { User } from "@/api/types";

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

/**
 * Marks why the session ended when it was a deliberate logout. Kept in the
 * QueryClient (not module state), so it is per client and is dropped like
 * any other user data on the next login.
 */
const deliberateLogoutKey = ["auth", "deliberate-logout"] as const;

/**
 * Whether the session ended because the user logged out on purpose (not
 * because it expired). ProtectedRoute then redirects to login without
 * `from`: the next person who logs in must not land on the previous user's page.
 */
export function endedByDeliberateLogout(queryClient: QueryClient): boolean {
  return queryClient.getQueryData(deliberateLogoutKey) === true;
}

function setSession(queryClient: QueryClient, user: User | null, { deliberate = false } = {}): void {
  // Exact key match: any other query (even another one under "auth") is
  // user data and must go.
  const isOtherQuery = (query: { queryHash: string }) => query.queryHash !== sessionQueryHash;
  // Cancel in-flight fetches first, so a late response cannot recreate a
  // query with the previous user's data after it was removed.
  void queryClient.cancelQueries({ predicate: isOtherQuery });
  queryClient.removeQueries({ predicate: isOtherQuery });
  // Mutations keep their variables (login password, request notes…) in memory.
  queryClient.getMutationCache().clear();
  // Set before the session, so ProtectedRoute already sees it when it reacts.
  if (deliberate) {
    queryClient.setQueryData(deliberateLogoutKey, true);
  }
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
  return useMutation({
    mutationFn: logout,
    // With the session null, ProtectedRoute sends the user to login; the
    // "deliberate" mark makes it do so without `from`. Deciding it there
    // (instead of navigating here and clearing the session right after) does
    // not depend on the order in which React Router's navigation and
    // TanStack Query's update happen to render, which is not guaranteed.
    onSuccess: () => setSession(queryClient, null, { deliberate: true }),
  });
}
