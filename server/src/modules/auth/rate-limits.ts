import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { UnauthorizedError } from "../../errors/AppError.js";

const TOO_MANY_ATTEMPTS = {
  error: "Demasiados intentos. Intenta de nuevo más tarde.",
  code: "TOO_MANY_ATTEMPTS",
};

const WINDOW_MS = 15 * 60 * 1000;

/** Login: by IP (there is no user yet); only failed logins count. */
export const loginLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: TOO_MANY_ATTEMPTS,
});

/** res.locals flag set by the route: this response was a wrong current password. */
export const WRONG_CURRENT_PASSWORD = "wrongCurrentPassword";

function userIdOf(req: Request): string {
  if (!req.user) throw new UnauthorizedError();
  return req.user.id;
}

/** Store keys of the change-password limiters, also used to clear them after an HR reset. */
const failedAttemptsKey = (userId: string) => `change-password:failed:${userId}`;
const requestsKey = (userId: string) => `change-password:all:${userId}`;

/**
 * Limits guesses of the current password with a stolen session (e.g. an
 * unlocked computer). Keyed by user id, not IP: it runs after requireAuth,
 * so it does not depend on `trust proxy`. Only wrong current passwords
 * count: a new password rejected by the policy says nothing about the
 * current one, so it does not use up attempts.
 */
export const changePasswordFailedAttemptsLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => failedAttemptsKey(userIdOf(req)),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req: Request, res: Response) => res.locals[WRONG_CURRENT_PASSWORD] !== true,
  message: TOO_MANY_ATTEMPTS,
});

/**
 * Every change-password request counts here, whatever the answer: each one
 * may cost an argon2 verification (e.g. sending the current password as the
 * new one, PASSWORD_UNCHANGED, which the limiter above does not count).
 */
export const changePasswordRequestsLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => requestsKey(userIdOf(req)),
  message: TOO_MANY_ATTEMPTS,
});

/**
 * Clears both change-password counters of a user. Called after an HR
 * reset: the employee gets a new temporary password and every session of
 * theirs (an attacker's included) has just ended, so a lockout earned with
 * the previous password must not keep them out of the new one.
 */
export async function resetChangePasswordLimits(userId: string): Promise<void> {
  await Promise.all([
    changePasswordFailedAttemptsLimiter.resetKey(failedAttemptsKey(userId)),
    changePasswordRequestsLimiter.resetKey(requestsKey(userId)),
  ]);
}
