import { CircleCheck } from "lucide-react";

/**
 * Live region for "Departamento creado" and similar messages. Always mounted
 * (empty until there is a message): screen readers announce text added to an
 * existing region, not a region that appears already filled.
 */
export function ActionStatus({ message }: { message: string | null }) {
  return (
    <div role="status" className={message ? "mb-4" : undefined}>
      {message ? (
        <p className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <CircleCheck className="size-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
          {message}
        </p>
      ) : null}
    </div>
  );
}
