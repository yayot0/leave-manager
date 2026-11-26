import type {
  DeactivationImpact,
  Department,
  Employee,
  EmployeeDetail,
  Holiday,
  HrLeaveType,
  LeaveRequest,
  LeaveRequestDetail,
  LeaveRequestPreview,
  LeaveType,
  PendingApproval,
  Person,
  RequesterBalance,
  Role,
  User,
  VacationBalance,
} from "@/api/types";

export function buildUser(role: Role, overrides: Partial<User> = {}): User {
  return {
    id: `user-${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@empresa.com`,
    firstName: "Ana",
    lastName: "García",
    role,
    hireDate: "2021-03-15T00:00:00.000Z",
    isActive: true,
    mustChangePassword: false,
    departmentId: null,
    managerId: null,
    createdAt: "2021-03-15T00:00:00.000Z",
    updatedAt: "2021-03-15T00:00:00.000Z",
    ...overrides,
  };
}

export const VALID_PASSWORD = "contraseña-correcta";

// ---------- Leave requests ----------

export const VACATION_TYPE: LeaveType = {
  id: "type-vac",
  code: "VAC",
  name: "Vacaciones",
  countsAgainstVacationBalance: true,
  maxBusinessDaysPerRequest: null,
};

export const PERSONAL_TYPE: LeaveType = {
  id: "type-personal",
  code: "PERSONAL",
  name: "Permiso personal",
  countsAgainstVacationBalance: false,
  maxBusinessDaysPerRequest: 1,
};

export function buildBalance(overrides: Partial<VacationBalance> = {}): VacationBalance {
  return {
    period: { start: "2026-03-15", end: "2027-03-14" },
    yearsOfService: 5,
    earned: 20,
    adjustments: 2,
    approved: 5,
    pending: 3,
    available: 14,
    asOf: "2026-11-17",
    ...overrides,
  };
}

export function buildLeaveRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  const leaveType = overrides.leaveType ?? VACATION_TYPE;
  return {
    // The request's copy defaults to its type's value, as the API stores it.
    countsAgainstVacationBalance: leaveType.countsAgainstVacationBalance,
    id: "req-1",
    startDate: "2026-12-01",
    endDate: "2026-12-03",
    businessDays: 3,
    reason: null,
    status: "PENDING",
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-11-10T16:00:00.000Z",
    leaveType: VACATION_TYPE,
    permissions: { canCancel: true },
    ...overrides,
  };
}

export const EMPLOYEE_PERSON: Person = { id: "user-employee", firstName: "Ana", lastName: "García" };
export const MANAGER_PERSON: Person = { id: "user-manager", firstName: "Luis", lastName: "Pérez" };

export function buildDetail(overrides: Partial<LeaveRequestDetail> = {}): LeaveRequestDetail {
  const leaveType = overrides.leaveType ?? VACATION_TYPE;
  return {
    countsAgainstVacationBalance: leaveType.countsAgainstVacationBalance,
    id: "req-1",
    startDate: "2026-12-01",
    endDate: "2026-12-03",
    businessDays: 3,
    reason: "Viaje familiar",
    status: "PENDING",
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-11-10T16:00:00.000Z",
    updatedAt: "2026-11-10T16:00:00.000Z",
    leaveType: VACATION_TYPE,
    requester: EMPLOYEE_PERSON,
    decider: null,
    events: [
      { id: "ev-1", action: "CREATED", note: null, createdAt: "2026-11-10T16:00:00.000Z", actor: EMPLOYEE_PERSON },
    ],
    isOverdue: false,
    requesterBalance: null,
    permissions: { canApprove: false, canReject: false, canCancel: true },
    ...overrides,
  };
}

export function buildPreview(overrides: Partial<LeaveRequestPreview> = {}): LeaveRequestPreview {
  return {
    businessDays: 3,
    leaveType: VACATION_TYPE,
    balance: { period: { start: "2026-03-15", end: "2027-03-14" }, available: 14, availableAfter: 11 },
    problems: [],
    canSubmit: true,
    ...overrides,
  };
}

/** Detail as the requester's manager sees it: can decide, with the requester's balance. */
export function buildDecidableDetail(overrides: Partial<LeaveRequestDetail> = {}): LeaveRequestDetail {
  return buildDetail({
    requesterBalance: buildRequesterBalance(),
    permissions: { canApprove: true, canReject: true, canCancel: false },
    ...overrides,
  });
}

export function buildRequesterBalance(overrides: Partial<RequesterBalance> = {}): RequesterBalance {
  return {
    period: { start: "2026-03-15", end: "2027-03-14" },
    availableWithoutRequest: 14,
    availableAfterApproval: 11,
    blocksApproval: false,
    ...overrides,
  };
}

export function buildPendingApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  const leaveType = overrides.leaveType ?? VACATION_TYPE;
  return {
    countsAgainstVacationBalance: leaveType.countsAgainstVacationBalance,
    id: "req-1",
    startDate: "2026-12-01",
    endDate: "2026-12-03",
    businessDays: 3,
    reason: "Viaje familiar",
    createdAt: "2026-11-10T16:00:00.000Z",
    leaveType: VACATION_TYPE,
    requester: EMPLOYEE_PERSON,
    isOverdue: false,
    ...overrides,
  };
}

// ---------- HR catalogs ----------

export function buildDepartment(overrides: Partial<Department> = {}): Department {
  return {
    id: "dep-1",
    name: "Ventas",
    employeeCount: 0,
    createdAt: "2026-01-10T16:00:00.000Z",
    updatedAt: "2026-01-10T16:00:00.000Z",
    ...overrides,
  };
}

export function buildHrLeaveType(overrides: Partial<HrLeaveType> = {}): HrLeaveType {
  return {
    ...VACATION_TYPE,
    isActive: true,
    requestCount: 0,
    createdAt: "2026-01-10T16:00:00.000Z",
    updatedAt: "2026-01-10T16:00:00.000Z",
    ...overrides,
  };
}

export function buildHoliday(overrides: Partial<Holiday> = {}): Holiday {
  return {
    id: "hol-1",
    date: "2026-11-16",
    name: "Día de la Revolución Mexicana",
    createdAt: "2026-01-10T16:00:00.000Z",
    updatedAt: "2026-01-10T16:00:00.000Z",
    ...overrides,
  };
}

// ---------- Employees (HR) ----------

export function buildEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp-1",
    email: "laura.mendez@empresa.com",
    firstName: "Laura",
    lastName: "Méndez Ortiz",
    role: "EMPLOYEE",
    hireDate: "2022-01-10",
    isActive: true,
    mustChangePassword: false,
    departmentId: "dep-1",
    managerId: "mgr-1",
    department: { id: "dep-1", name: "Tecnología" },
    manager: { id: "mgr-1", firstName: "Ricardo", lastName: "Montemayor" },
    createdAt: "2022-01-10T15:00:00.000Z",
    updatedAt: "2026-11-01T15:00:00.000Z",
    ...overrides,
  };
}

export function buildEmployeeDetail(overrides: Partial<EmployeeDetail> = {}): EmployeeDetail {
  const { manager: _manager, ...base } = buildEmployee();
  return {
    ...base,
    manager: { id: "mgr-1", firstName: "Ricardo", lastName: "Montemayor", role: "MANAGER", isActive: true },
    directReports: [],
    balance: buildBalance(),
    permissions: {
      canEditRole: true,
      canEditHireDate: true,
      canEditManager: true,
      canDeactivate: true,
      canReactivate: false,
      canResetPassword: true,
    },
    ...overrides,
  };
}

export function buildDeactivationImpact(overrides: Partial<DeactivationImpact> = {}): DeactivationImpact {
  return {
    activeReports: [],
    overdueRequests: [],
    toCancel: { pending: 0, approved: 0 },
    startedApproved: 0,
    approvedRunningPastToday: 0,
    isLastActiveHr: false,
    blocker: null,
    ...overrides,
  };
}
