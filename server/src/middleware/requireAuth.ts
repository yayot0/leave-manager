import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { UnauthorizedError } from "../errors/AppError.js";
import { verifyAuthToken } from "../security/jwt.js";
import { toPublicUser } from "../modules/auth/public-user.js";
import { AUTH_COOKIE_NAME } from "../modules/auth/cookie.js";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];

  if (!token) {
    next(new UnauthorizedError());
    return;
  }

  let userId: string | undefined;
  try {
    userId = await verifyAuthToken(token);
  } catch {
    next(new UnauthorizedError());
    return;
  }

  if (!userId) {
    next(new UnauthorizedError());
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user || !user.isActive) {
      next(new UnauthorizedError());
      return;
    }

    req.user = toPublicUser(user);
    next();
  } catch (err) {
    // Un fallo de infraestructura (p. ej. la base caída) no es un problema de
    // autenticación: se propaga como 500 real al errorHandler en vez de
    // disfrazarse de "No autenticado".
    next(err);
  }
}
