import type { User } from "../../generated/prisma/client.js";

/**
 * The user as the API shows it (login, /auth/me, change-password) and as
 * `req.user` carries it. A WHITELIST on purpose: a new column of `users`
 * (RH-B2 will add some) stays private until it is added here. Never
 * passwordHash; passwordChangedAt stays inside the session token check.
 */
const PUBLIC_USER_FIELDS = [
  "id",
  "email",
  "firstName",
  "lastName",
  "role",
  "hireDate",
  "isActive",
  "mustChangePassword",
  "departmentId",
  "managerId",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof User)[];

export type PublicUser = Pick<User, (typeof PUBLIC_USER_FIELDS)[number]>;

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    hireDate: user.hireDate,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    departmentId: user.departmentId,
    managerId: user.managerId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
