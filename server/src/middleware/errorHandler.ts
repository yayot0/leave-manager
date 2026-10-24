import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";

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

  console.error(err);
  res.status(500).json({ error: "Error interno del servidor" });
}
