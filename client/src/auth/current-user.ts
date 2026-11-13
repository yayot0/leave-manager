import { createContext, useContext } from "react";
import type { User } from "@/api/types";

/**
 * Provided by ProtectedRoute. A context (instead of reading the session query
 * in every component) guarantees that children always get a non-null user:
 * when the session is cleared (logout, 401) a child may re-render before
 * ProtectedRoute redirects, and it keeps seeing the last user until the guard
 * unmounts it.
 */
export const CurrentUserContext = createContext<User | null>(null);

/** The logged-in user. Only for components rendered inside ProtectedRoute. */
export function useCurrentUser(): User {
  const user = useContext(CurrentUserContext);
  if (!user) {
    throw new Error("useCurrentUser must be used inside ProtectedRoute");
  }
  return user;
}
