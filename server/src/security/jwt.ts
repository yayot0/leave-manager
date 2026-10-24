import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

export async function signAuthToken(userId: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setSubject(userId)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + env.SESSION_TTL_SECONDS)
    .sign(secret);
}

export async function verifyAuthToken(token: string): Promise<string | undefined> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
  return payload.sub;
}
