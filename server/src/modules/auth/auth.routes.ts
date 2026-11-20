import { Router } from "express";
import { authenticate, changeOwnPassword } from "./auth.service.js";
import { changePasswordSchema, loginSchema } from "./auth.schemas.js";
import { toPublicUser } from "./public-user.js";
import { AUTH_COOKIE_NAME, authCookieOptions } from "./cookie.js";
import {
  changePasswordFailedAttemptsLimiter,
  changePasswordRequestsLimiter,
  loginLimiter,
  WRONG_CURRENT_PASSWORD,
} from "./rate-limits.js";
import { signAuthToken } from "../../security/jwt.js";
import { requireAuthAllowingPasswordChange } from "../../middleware/requireAuth.js";
import { AppError, UnauthorizedError } from "../../errors/AppError.js";

export const authRouter = Router();

// Session data (the user, a new cookie): no cache may keep these answers.
authRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await authenticate(email, password);
  if (!user) {
    throw new UnauthorizedError("Credenciales inválidas");
  }

  const token = await signAuthToken(user.id, user.passwordChangedAt);
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
  res.json({ user: toPublicUser(user) });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions);
  res.json({ message: "Sesión cerrada" });
});

authRouter.get("/me", requireAuthAllowingPasswordChange, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post(
  "/change-password",
  requireAuthAllowingPasswordChange,
  changePasswordRequestsLimiter,
  changePasswordFailedAttemptsLimiter,
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError();
    const input = changePasswordSchema.parse(req.body ?? {});

    const user = await changeOwnPassword(req.user.id, input).catch((err: unknown) => {
      if (err instanceof AppError && err.code === "INVALID_CURRENT_PASSWORD") {
        res.locals[WRONG_CURRENT_PASSWORD] = true;
      }
      throw err;
    });

    // This session continues with a token that carries the new passwordChangedAt;
    // every other token of the user now fails in requireAuth.
    const token = await signAuthToken(user.id, user.passwordChangedAt);
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
    res.json({ user: toPublicUser(user) });
  },
);
