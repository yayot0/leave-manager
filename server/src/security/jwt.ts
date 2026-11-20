import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

/**
 * Claim with the user's passwordChangedAt (epoch ms) when the token was
 * issued. requireAuth rejects a token whose value differs from the user's
 * current one, so changing or resetting the password ends every older
 * session. Milliseconds on purpose: `iat` has only seconds, and a token
 * issued in the same second as a change would be ambiguous.
 */
const PASSWORD_CHANGED_AT_CLAIM = "pca";

export interface AuthTokenPayload {
  userId: string;
  passwordChangedAtMs: number;
}

export async function signAuthToken(userId: string, passwordChangedAt: Date): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ [PASSWORD_CHANGED_AT_CLAIM]: passwordChangedAt.getTime() })
    .setSubject(userId)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + env.SESSION_TTL_SECONDS)
    .sign(secret);
}

/**
 * Verifies signature and expiry. Returns undefined when the token lacks the
 * subject or the password claim (e.g. issued before RH-B1): such a token is
 * not a valid session.
 */
export async function verifyAuthToken(token: string): Promise<AuthTokenPayload | undefined> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
  const passwordChangedAtMs = payload[PASSWORD_CHANGED_AT_CLAIM];
  if (!payload.sub || typeof passwordChangedAtMs !== "number" || !Number.isFinite(passwordChangedAtMs)) {
    return undefined;
  }
  return { userId: payload.sub, passwordChangedAtMs };
}
