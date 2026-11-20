import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError.js";
import { verifyAuthToken, type AuthTokenPayload } from "../security/jwt.js";
import { toPublicUser } from "../modules/auth/public-user.js";
import { AUTH_COOKIE_NAME } from "../modules/auth/cookie.js";
import { withAuthCode } from "../modules/auth/errors.js";

interface RequireAuthOptions {
  /**
   * Let a user with a temporary password through. Only for GET /auth/me and
   * POST /auth/change-password: everything else is blocked by default, so a
   * new route cannot forget it.
   */
  allowPasswordChangeRequired?: boolean;
}

function createRequireAuth({ allowPasswordChangeRequired = false }: RequireAuthOptions = {}) {
  return async function requireAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
    const token = req.cookies?.[AUTH_COOKIE_NAME];

    if (!token) {
      next(new UnauthorizedError());
      return;
    }

    let payload: AuthTokenPayload | undefined;
    try {
      payload = await verifyAuthToken(token);
    } catch {
      next(new UnauthorizedError());
      return;
    }

    if (!payload) {
      next(new UnauthorizedError());
      return;
    }

    try {
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });

      if (!user || !user.isActive) {
        next(new UnauthorizedError());
        return;
      }

      // A token issued before the last password change (own change or HR
      // reset) is no longer a valid session.
      if (payload.passwordChangedAtMs !== user.passwordChangedAt.getTime()) {
        next(new UnauthorizedError());
        return;
      }

      if (user.mustChangePassword && !allowPasswordChangeRequired) {
        next(
          withAuthCode(
            new ForbiddenError("Debes cambiar tu contraseña temporal antes de continuar"),
            "PASSWORD_CHANGE_REQUIRED",
          ),
        );
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
  };
}

/** Requires a valid session; 403 PASSWORD_CHANGE_REQUIRED while the password is temporary. */
export const requireAuth = createRequireAuth();

/** Like requireAuth, but also lets a temporary-password session through (see options). */
export const requireAuthAllowingPasswordChange = createRequireAuth({ allowPasswordChangeRequired: true });
