import type { NextFunction, Request, Response } from "express";
import type { Role } from "../generated/prisma/client.js";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError.js";

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError());
      return;
    }

    next();
  };
}
