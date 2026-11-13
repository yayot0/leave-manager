import type { Role, User } from "@/api/types";

export function buildUser(role: Role, overrides: Partial<User> = {}): User {
  return {
    id: `user-${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@empresa.com`,
    firstName: "Ana",
    lastName: "García",
    role,
    hireDate: "2021-03-15T00:00:00.000Z",
    isActive: true,
    departmentId: null,
    managerId: null,
    createdAt: "2021-03-15T00:00:00.000Z",
    updatedAt: "2021-03-15T00:00:00.000Z",
    ...overrides,
  };
}

export const VALID_PASSWORD = "contraseña-correcta";
