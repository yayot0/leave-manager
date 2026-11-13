import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";

const MAX_RETRIES = 2;

/**
 * Retries only failures that may be transient (network, 5xx). A 4xx means
 * the request itself is wrong (or unauthorized): repeating it gives the same
 * answer.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry },
      mutations: { retry: false },
    },
  });
}
