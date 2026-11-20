import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { lockUser } from "../../db/locks.js";
import { hashPassword, normalizePassword, verifyPassword } from "../../security/password.js";
import { checkPasswordPolicy, PASSWORD_POLICY_MESSAGES } from "../../security/password-policy.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "../../errors/AppError.js";
import type { User } from "../../generated/prisma/client.js";
import type { ChangePasswordInput } from "./auth.schemas.js";
import { withAuthCode } from "./errors.js";

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

/**
 * The value to store as passwordChangedAt: now, but always later than the
 * previous one. Session tokens are compared by equality with this column,
 * so two changes in the same millisecond must still give different values
 * (otherwise a token from before the second change would stay valid).
 */
export function nextPasswordChangedAt(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

/**
 * A user changes their own password (also the way out of a temporary one).
 * Order: the policy first (cheap, and says nothing about the current
 * password), then the current password (the rate-limited check), then the
 * hash outside the transaction (argon2 is slow; no lock is held meanwhile).
 * Returns the updated user; the caller signs a new token for this session.
 * Every other session dies because passwordChangedAt changes.
 */
export async function changeOwnPassword(userId: string, input: ChangePasswordInput): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) throw new UnauthorizedError();

  const problem = checkPasswordPolicy(input.newPassword, user);
  if (problem) {
    throw withAuthCode(new BadRequestError(PASSWORD_POLICY_MESSAGES[problem]), problem);
  }

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw withAuthCode(new BadRequestError("La contraseña actual no es correcta"), "INVALID_CURRENT_PASSWORD");
  }

  if (normalizePassword(input.newPassword) === normalizePassword(input.currentPassword)) {
    throw withAuthCode(
      new BadRequestError("La contraseña nueva debe ser distinta de la actual"),
      "PASSWORD_UNCHANGED",
    );
  }

  const passwordHash = await hashPassword(input.newPassword);

  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const current = await tx.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, passwordChangedAt: true, isActive: true },
    });
    if (!current || !current.isActive) throw new UnauthorizedError();

    // HR reset (or another change) slipped in after the current password
    // was verified: that check no longer holds, so nothing is written.
    if (current.passwordHash !== user.passwordHash) {
      throw withAuthCode(
        new ConflictError("Tu contraseña cambió mientras tanto. Vuelve a iniciar sesión."),
        "STALE_DATA",
      );
    }

    return tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: nextPasswordChangedAt(current.passwordChangedAt),
      },
    });
  });
}
