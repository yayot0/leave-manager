import { LoaderCircle, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "./PageHeading";

export function FullPageLoading({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div role="status" className="flex items-center gap-2 text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
}

interface FullPageErrorProps {
  title: string;
  message: string;
  onRetry?: () => void;
}

export function FullPageError({ title, message, onRetry }: FullPageErrorProps) {
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <title>{`${title} · ${APP_NAME}`}</title>
      <div className="max-w-sm space-y-4 text-center">
        <TriangleAlert className="mx-auto size-8 text-destructive" aria-hidden="true" />
        {/* Only the title and message are announced; the button stays out of the alert. */}
        <div role="alert" className="space-y-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        {onRetry ? <Button onClick={onRetry}>Reintentar</Button> : null}
      </div>
    </main>
  );
}
