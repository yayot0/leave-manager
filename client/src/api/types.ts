// Types for the API responses. They mirror the server's shapes
// (e.g. `PublicUser` in server/src/modules/auth/public-user.ts), but dates
// are strings because they travel as JSON.

export type Role = "EMPLOYEE" | "MANAGER" | "HR";

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  /** ISO date, e.g. "2021-03-15T00:00:00.000Z" (date-only, midnight UTC). */
  hireDate: string;
  isActive: boolean;
  departmentId: string | null;
  managerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body the API sends on any error (see server/src/middleware/errorHandler.ts). */
export interface ApiErrorBody {
  error: string;
  details?: string[];
}

export interface UserResponse {
  user: User;
}
