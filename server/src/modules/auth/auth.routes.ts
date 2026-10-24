import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "./auth.service.js";
import { loginSchema } from "./auth.schemas.js";
import { toPublicUser } from "./public-user.js";
import { AUTH_COOKIE_NAME, authCookieOptions } from "./cookie.js";
import { signAuthToken } from "../../security/jwt.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { UnauthorizedError } from "../../errors/AppError.js";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Demasiados intentos. Intenta de nuevo más tarde." },
});

export const authRouter = Router();

authRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await authenticate(email, password);
  if (!user) {
    throw new UnauthorizedError("Credenciales inválidas");
  }

  const token = await signAuthToken(user.id);
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
  res.json({ user: toPublicUser(user) });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions);
  res.json({ message: "Sesión cerrada" });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});
