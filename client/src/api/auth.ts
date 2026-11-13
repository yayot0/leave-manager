import { ApiError, apiFetch } from "./client";
import type { User, UserResponse } from "./types";

export interface LoginCredentials {
  email: string;
  password: string;
}

export async function login(credentials: LoginCredentials): Promise<User> {
  // 401 here means "wrong email or password", not "session expired".
  const { user } = await apiFetch<UserResponse>("/auth/login", {
    method: "POST",
    body: credentials,
    handleUnauthorized: false,
  });
  return user;
}

export async function logout(): Promise<void> {
  await apiFetch<unknown>("/auth/logout", { method: "POST" });
}

/**
 * Returns the logged-in user, or `null` when there is no valid session.
 * Having no session is a normal state (the login page handles it), not an error.
 */
export async function getMe(signal?: AbortSignal): Promise<User | null> {
  try {
    const { user } = await apiFetch<UserResponse>("/auth/me", { signal, handleUnauthorized: false });
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return null;
    }
    throw err;
  }
}
