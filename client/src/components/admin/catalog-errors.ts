import { ApiError } from "@/api/client";
import type { HrErrorCode } from "@/api/types";

export type CatalogField = "name" | "code" | "date" | "max";

/** Which form field an error belongs to, by ApiError.code (never by the message). */
const FIELD_OF_CODE: Partial<Record<HrErrorCode, CatalogField>> = {
  DUPLICATE_NAME: "name",
  DUPLICATE_CODE: "code",
  DUPLICATE_DATE: "date",
  LIMIT_BELOW_LFT_MINIMUM: "max",
};

export interface CatalogFormError {
  /** The field to mark and focus; null = a general error (alert in the dialog). */
  field: CatalogField | null;
  title: string;
  message: string;
  /** Sending the same form again can never succeed: only "Volver" is offered. */
  locked: boolean;
}

/**
 * Splits a catalog mutation error into a field error (shown under the field
 * that caused it, e.g. a duplicate name) or a general one (shown in an alert
 * inside the dialog).
 */
export function catalogFormError(error: Error | null): CatalogFormError | null {
  if (!error) {
    return null;
  }
  if (error instanceof ApiError) {
    const field = error.code ? (FIELD_OF_CODE[error.code as HrErrorCode] ?? null) : null;
    if (field) {
      return { field, title: "Revisa el formulario", message: error.message, locked: false };
    }
    if (error.code === "STALE_DATA") {
      return {
        field: null,
        title: "Alguien más lo cambió",
        message:
          "Otra persona guardó cambios mientras lo editabas; no se sobrescribieron. Cierra este aviso y vuelve a abrirlo para ver lo actual.",
        locked: true,
      };
    }
    if (error.status === 404) {
      return {
        field: null,
        title: "Ya no existe",
        message: "Alguien más lo borró mientras tenías esto abierto. Cierra este aviso para ver la lista actualizada.",
        locked: true,
      };
    }
    if (error.status === 400 && error.details.length > 0) {
      return { field: null, title: "Revisa los datos", message: error.details.join(" "), locked: false };
    }
  }
  return { field: null, title: "No se pudo guardar", message: error.message, locked: false };
}

/** Props for an input with an optional error message below it. */
export function fieldErrorProps(error: string | null, errorId: string, hintId?: string) {
  const describedBy = [error ? errorId : null, hintId ?? null].filter(Boolean).join(" ");
  return {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
  } as const;
}
