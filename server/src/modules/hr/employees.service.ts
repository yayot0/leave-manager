import { prisma } from "../../db/prisma.js";
import { lockUser } from "../../db/locks.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../errors/AppError.js";
import { hashPassword } from "../../security/password.js";
import { generateTemporaryPassword } from "../../security/temporary-password.js";
import { nextPasswordChangedAt } from "../auth/auth.service.js";
import { recordHrAudit, type AuditSnapshot } from "./audit.js";
import { withCode } from "./errors.js";

/**
 * The only fields a PASSWORD_RESET entry records (the database CHECK
 * chk_hr_audit_logs_password_reset_shape accepts exactly these two): never
 * the password, its hash or anything else about the user.
 */
function passwordAuditSnapshot(user: { mustChangePassword: boolean; passwordChangedAt: Date }): AuditSnapshot {
  return {
    mustChangePassword: user.mustChangePassword,
    passwordChangedAt: user.passwordChangedAt.toISOString(),
  };
}

export interface PasswordResetResult {
  /** Shown to HR once, in this response; only its hash is stored. */
  temporaryPassword: string;
  user: { id: string; email: string; firstName: string; lastName: string };
}

/**
 * HR gives an employee a new temporary password: only its hash is stored,
 * the employee must replace it on the next login (mustChangePassword), and
 * every session of the employee ends (passwordChangedAt changes). The audit
 * entry says that a reset happened, without the secret.
 */
export async function resetEmployeePassword(actorId: string, employeeId: string): Promise<PasswordResetResult> {
  // HR would learn its own new password and skip the current-password
  // check (and its rate limit): its own password is changed in "Mi cuenta".
  if (actorId === employeeId) {
    throw withCode(
      new ForbiddenError("No puedes restablecer tu propia contraseña; cámbiala desde Mi cuenta"),
      "CANNOT_RESET_OWN_PASSWORD",
    );
  }

  // Generated and hashed before the transaction: argon2 is slow and no
  // lock should be held meanwhile.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const select = {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    isActive: true,
    mustChangePassword: true,
    passwordChangedAt: true,
  } as const;

  const user = await prisma.$transaction(async (tx) => {
    await lockUser(tx, employeeId);
    const before = await tx.user.findUnique({ where: { id: employeeId }, select });
    if (!before) throw new NotFoundError("Empleado no encontrado");
    if (!before.isActive) {
      throw withCode(
        new ConflictError("El empleado está inactivo: no puede iniciar sesión"),
        "EMPLOYEE_INACTIVE",
      );
    }

    const after = await tx.user.update({
      where: { id: employeeId },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: nextPasswordChangedAt(before.passwordChangedAt),
      },
      select,
    });

    await recordHrAudit(tx, {
      actorId,
      entityType: "EMPLOYEE",
      entityId: employeeId,
      action: "PASSWORD_RESET",
      before: passwordAuditSnapshot(before),
      after: passwordAuditSnapshot(after),
    });

    return after;
  });

  return {
    temporaryPassword,
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
  };
}
