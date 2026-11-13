import type { Role } from "@/api/types";
import { canAccess, HOME_ROUTE, normalizePath, ROUTES } from "@/app/navigation";

/** Location state the login page reads to return the user where they were. */
export interface LoginLocationState {
  from?: string;
}

/**
 * Where a logged-in user goes from the login page: back to the page that
 * sent them to login, if it is an in-app path their role can open; otherwise
 * the home page.
 */
export function redirectTarget(state: unknown, role: Role): string {
  const from = (state as LoginLocationState | null)?.from;

  // First filter: only paths ("/…"), never "//host" or absolute URLs.
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//")) {
    return HOME_ROUTE;
  }

  // Second filter: let the browser's URL parser decide where it really points.
  // It strips tabs/newlines and treats "\" like "/", so "/\t/evil.com" or
  // "/\evil.com" become "//evil.com" (another site). Comparing origins covers
  // every such parser trick instead of listing them one by one.
  let url: URL;
  try {
    url = new URL(from, window.location.origin);
  } catch {
    return HOME_ROUTE;
  }
  if (url.origin !== window.location.origin) {
    return HOME_ROUTE;
  }

  if (normalizePath(url.pathname) === ROUTES.login || !canAccess(url.pathname, role)) {
    return HOME_ROUTE;
  }

  // Rebuilt from the parsed URL, so what we navigate to is exactly what we checked.
  return url.pathname + url.search + url.hash;
}
