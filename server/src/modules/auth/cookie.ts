import type { CookieOptions } from "express";
import { env } from "../../config/env.js";

export const AUTH_COOKIE_NAME = "auth_token";

export const authCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  path: "/",
  maxAge: env.SESSION_TTL_SECONDS * 1000,
};
