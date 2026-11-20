import { hashKey, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { changePassword, getMe, login, logout } from "@/api/auth";
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

/**
 * Changes the user's own password. Same user afterwards, so the cache is
 * kept and only the session is replaced (with mustChangePassword false, a
 * temporary-password session opens the rest of the app). `gcTime: 0`
 * drops the mutation, which holds both passwords in its variables, as soon
 * as the page resets it or unmounts.
 */
export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: changePassword,
    gcTime: 0,
    onSuccess: (user) => replaceSessionUser(queryClient, user),
  });
}

/**
 * Stores the user the API just returned. Same id: only the session changes
 * (the cache is that user's). Another id or no user (e.g. another tab logged
 * in with a different account, which replaces the shared cookie): it is a
 * change of user, so everything cached is dropped, like on login.
 */
function replaceSessionUser(
  queryClient: QueryClient,
  user: User | null,
  previous = queryClient.getQueryData<User | null>(sessionQueryKey),
): void {
  if (user && previous && user.id === previous.id) {
    queryClient.setQueryData(sessionQueryKey, user);
  } else {
    setSession(queryClient, user);
  }
}

/**
 * The API answered 403 PASSWORD_CHANGE_REQUIRED: this session belongs to a
 * temporary-password account. That happens when another tab logs in with
 * such an account (the cookie is shared), so it is usually ANOTHER user.
 * Re-reads /auth/me and stores it with replaceSessionUser; ProtectedRoute
 * then shows "Mi cuenta". Several 403 at once share one /me request
 * (fetchQuery reuses the one in flight).
 */
export async function refreshSessionAfterPasswordChangeRequired(queryClient: QueryClient): Promise<void> {
  // Read before fetching: fetchQuery itself writes the new user into the cache.
  const previous = queryClient.getQueryData<User | null>(sessionQueryKey);
  try {
    const user = await queryClient.fetchQuery({
      queryKey: sessionQueryKey,
      queryFn: ({ signal }) => getMe(signal),
      staleTime: 0,
    });
    replaceSessionUser(queryClient, user, previous);
  } catch {
    // Network error: keep the current state; the next request will tell.
  }
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
