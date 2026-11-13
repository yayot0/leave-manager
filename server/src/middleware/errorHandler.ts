import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import { isTransactionTimeout } from "../db/pg-errors.js";

/**
 * Errors raised by Express's own middleware (e.g. express.json() on a
 * malformed body or a payload over the size limit) carry an HTTP 4xx
 * `status` and a `type` like "entity.parse.failed". They are client errors,
 * not server failures.
 */
interface HttpClientError {
  status: number;
  type?: string;
}

function isHttpClientError(err: unknown): err is HttpClientError {
  if (typeof err !== "object" || err === null || !("status" in err)) {
    return false;
  }
  const { status } = err as { status: unknown };
  return typeof status === "number" && status >= 400 && status < 500;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Datos de entrada inválidos",
      details: err.issues.map((issue) => issue.message),
    });
    return;
  }

  if (isHttpClientError(err)) {
    const message =
      err.type === "entity.parse.failed"
        ? "El cuerpo de la petición no es JSON válido"
        : err.status === 413
          ? "El cuerpo de la petición es demasiado grande"
          : "Solicitud inválida";
    res.status(err.status).json({ error: message });
    return;
  }

  if (isTransactionTimeout(err)) {
    // Transient contention, not a bug: tell the client to retry.
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "El servidor está ocupado; intenta de nuevo en un momento" });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Error interno del servidor" });
}
