import { LoaderCircle, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Inline loading state for a section: skeleton lines plus a text for screen readers. */
export function LoadingBlock({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div role="status" className="space-y-3">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        {label}
      </p>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" aria-hidden="true" />
      ))}
    </div>
  );
}

interface QueryErrorProps {
  title: string;
  error: Error;
  onRetry?: () => void;
  isRetrying?: boolean;
}

/** Inline error of a query, with an optional retry button outside the alert. */
export function QueryError({ title, error, onRetry, isRetrying = false }: QueryErrorProps) {
  return (
    <div className="space-y-3">
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? "Reintentando…" : "Reintentar"}
        </Button>
      ) : null}
    </div>
  );
}
