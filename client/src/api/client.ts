import type { ApiErrorBody } from "./types";

/**
 * Every request to the API goes through `apiFetch`, so cookies, JSON
 * parsing, error messages and the "session expired" handling live in one
 * place.
 */

const NETWORK_ERROR_MESSAGE = "No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.";

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never got a response (network error). */
  readonly status: number;
  readonly details: string[];

  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Registers what to do when the API answers 401 (session expired or cookie
 * removed). Returns a function that unregisters it.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) {
      unauthorizedHandler = null;
    }
  };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /**
   * When true (default), a 401 response triggers the global unauthorized
   * handler (back to login). Disable it where 401 is an expected answer,
   * e.g. wrong credentials on login.
   */
  handleUnauthorized?: boolean;
}

/**
 * Calls `/api{path}` and returns the parsed JSON typed as `T`.
 *
 * Note: `T` is a compile-time promise, not a runtime check; the server is the
 * one validating with Zod. Throws `ApiError` for any non-2xx response.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, handleUnauthorized = true } = options;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  // Resolved against the page origin: in the browser it is the Vite dev server
  // (or the production domain), so the request is always same-origin.
  const url = new URL(`/api${path}`, window.location.origin);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Same-origin requests send the httpOnly session cookie automatically.
      credentials: "same-origin",
      signal,
    });
  } catch (err) {
    // Cancelled by TanStack Query (e.g. component unmounted): not an error to show.
    if (signal?.aborted) {
      throw err;
    }
    throw new ApiError(0, NETWORK_ERROR_MESSAGE);
  }

  const data = await readJson(response);

  if (!response.ok) {
    if (response.status === 401 && handleUnauthorized) {
      unauthorizedHandler?.();
    }
    const errorBody = isApiErrorBody(data) ? data : null;
    throw new ApiError(
      response.status,
      errorBody?.error ?? defaultMessageFor(response.status),
      errorBody?.details ?? [],
    );
  }

  return data as T;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (response.status === 204 || !contentType.includes("application/json")) {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

function defaultMessageFor(status: number): string {
  if (status === 401) return "Tu sesión expiró. Inicia sesión de nuevo.";
  if (status === 403) return "No tienes permiso para realizar esta acción.";
  if (status === 404) return "No se encontró el recurso solicitado.";
  if (status === 429) return "Demasiados intentos. Intenta de nuevo más tarde.";
  // The Vite proxy (or a reverse proxy) answers 5xx without JSON when the
  // API is down.
  if (status >= 500) return NETWORK_ERROR_MESSAGE;
  return "Ocurrió un error inesperado. Intenta de nuevo.";
}
