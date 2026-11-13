import { FullPageError } from "@/components/FullPageStatus";

/** Shown by React Router when a page throws while rendering. */
export function RouteErrorPage() {
  return (
    <FullPageError
      title="Algo salió mal"
      message="Ocurrió un error inesperado al mostrar esta página. Recarga para intentarlo de nuevo."
      onRetry={() => window.location.reload()}
    />
  );
}
