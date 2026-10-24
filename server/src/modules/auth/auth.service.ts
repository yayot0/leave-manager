import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { hashPassword, verifyPassword } from "../../security/password.js";
import type { User } from "../../generated/prisma/client.js";

// Hash dummy precalculado una sola vez: cuando el correo no existe, se verifica
// contra esto (mismo costo de cómputo que un intento real) para que el tiempo
// de respuesta no revele si el correo existe o no.
const DUMMY_HASH = await hashPassword(randomUUID());

export async function authenticate(email: string, password: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !user.isActive || !passwordOk) {
    return null;
  }

  return user;
}
