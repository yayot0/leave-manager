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
  /**
   * true while the password is a temporary one set by HR: the API answers
   * 403 PASSWORD_CHANGE_REQUIRED to everything except the session, changing
   * the password and logging out, and the app only shows "Mi cuenta".
   */
  mustChangePassword: boolean;
  departmentId: string | null;
  managerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body the API sends on any error (see server/src/middleware/errorHandler.ts). */
export interface ApiErrorBody {
  error: string;
  details?: string[];
  /** Business-rule reason, e.g. "OVERLAP" (same codes as the preview's problems). */
  code?: string;
}

export interface UserResponse {
  user: User;
}

// ---------- Leave requests and balance ----------
// Date-only fields ("YYYY-MM-DD") must be shown with the helpers in
// src/lib/dates.ts, never with `new Date(value)` in local time.

export type LeaveRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export type RequestEventAction = "CREATED" | "APPROVED" | "REJECTED" | "CANCELLED" | "MODIFIED";

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  /** The type's CURRENT value; a request keeps its own copy (see LeaveRequest). */
  countsAgainstVacationBalance: boolean;
  /** Most business days one request of this type may cover; null = no limit. */
  maxBusinessDaysPerRequest: number | null;
}

export interface LeaveTypesResponse {
  leaveTypes: LeaveType[];
}

export interface Person {
  id: string;
  firstName: string;
  lastName: string;
}

/** An item of GET /leave-requests/mine (and the POST response). */
export interface LeaveRequest {
  id: string;
  /** "YYYY-MM-DD" */
  startDate: string;
  /** "YYYY-MM-DD" */
  endDate: string;
  businessDays: number;
  reason: string | null;
  status: LeaveRequestStatus;
  /** Instant (ISO with time). */
  decidedAt: string | null;
  decisionNote: string | null;
  /** Instant (ISO with time). */
  createdAt: string;
  /**
   * Whether THIS request counts against the vacation balance: a copy taken
   * when it was created. Use it (not leaveType's) for anything about the
   * request: HR may have edited the type since.
   */
  countsAgainstVacationBalance: boolean;
  leaveType: LeaveType;
  /** Computed by the API from its state machine. */
  permissions: { canCancel: boolean };
}

export interface LeaveRequestsResponse {
  leaveRequests: LeaveRequest[];
}

export interface CreatedLeaveRequestResponse {
  leaveRequest: LeaveRequest;
}

export interface RequestEvent {
  id: string;
  action: RequestEventAction;
  note: string | null;
  /** Instant (ISO with time). */
  createdAt: string;
  actor: Person;
}

/**
 * The requester's vacation balance in the period of the request's start
 * date. Only sent to whoever can decide the request now, and only for leave
 * types that count against the balance; null otherwise.
 */
export interface RequesterBalance {
  period: DateRange;
  /** Available days without this request (what rejecting would leave). */
  availableWithoutRequest: number;
  /** Available days if it is approved (a PENDING request already reserves them). */
  availableAfterApproval: number;
  /** The period is already negative: approving would answer 422. */
  blocksApproval: boolean;
}

/** GET /leave-requests/:id (also returned by approve/reject/cancel). */
export interface LeaveRequestDetail extends Omit<LeaveRequest, "permissions"> {
  updatedAt: string;
  requester: Person;
  decider: Person | null;
  events: RequestEvent[];
  isOverdue: boolean;
  requesterBalance: RequesterBalance | null;
  permissions: { canApprove: boolean; canReject: boolean; canCancel: boolean };
}

/** An item of GET /leave-requests/pending-approvals (oldest start first, so overdue ones lead). */
export interface PendingApproval {
  id: string;
  /** "YYYY-MM-DD" */
  startDate: string;
  /** "YYYY-MM-DD" */
  endDate: string;
  businessDays: number;
  reason: string | null;
  /** Instant (ISO with time). */
  createdAt: string;
  /** The request's own copy (see LeaveRequest). */
  countsAgainstVacationBalance: boolean;
  leaveType: LeaveType;
  requester: Person;
  /** PENDING whose start date already arrived (it can still be decided). */
  isOverdue: boolean;
}

export interface PendingApprovalsResponse {
  leaveRequests: PendingApproval[];
}

export interface LeaveRequestDetailResponse {
  leaveRequest: LeaveRequestDetail;
}

export interface DateRange {
  /** "YYYY-MM-DD" */
  start: string;
  /** "YYYY-MM-DD" */
  end: string;
}

/** GET /me/balance: the anniversary period that contains today. */
export interface VacationBalance {
  period: DateRange;
  yearsOfService: number;
  earned: number;
  adjustments: number;
  approved: number;
  pending: number;
  available: number;
  /** "YYYY-MM-DD": the day the balance was computed for. */
  asOf: string;
}

export interface VacationBalanceResponse {
  balance: VacationBalance;
}

export type PreviewProblemCode =
  | "START_IN_PAST"
  | "START_TOO_FAR"
  | "INVALID_LEAVE_TYPE"
  | "NO_BUSINESS_DAYS"
  | "EXCEEDS_TYPE_LIMIT"
  | "OVERLAP"
  | "INSUFFICIENT_BALANCE";

export interface PreviewProblem {
  code: PreviewProblemCode;
  message: string;
}

/** GET /leave-requests/preview: what creating the request would do. */
export interface LeaveRequestPreview {
  businessDays: number;
  leaveType: LeaveType | null;
  /** null when the leave type does not count against the vacation balance. */
  balance: { period: DateRange; available: number; availableAfter: number } | null;
  problems: PreviewProblem[];
  canSubmit: boolean;
}

export interface LeaveRequestPreviewResponse {
  preview: LeaveRequestPreview;
}

// ---------- HR catalogs (GET/POST/PATCH/DELETE /hr/...) ----------

/** Reasons of the HR catalog 409s, in ApiError.code. */
export type HrErrorCode =
  | "DUPLICATE_NAME"
  | "DUPLICATE_CODE"
  | "DUPLICATE_DATE"
  | "DEPARTMENT_HAS_EMPLOYEES"
  /** Someone saved it after it was loaded (expectedUpdatedAt differs). */
  | "STALE_DATA"
  /** A type that counts against vacations cannot cap requests below 12 days (Art. 78 LFT). */
  | "LIMIT_BELOW_LFT_MINIMUM";

export interface Department {
  id: string;
  name: string;
  /** Active and inactive employees: either one blocks deleting it. */
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentsResponse {
  departments: Department[];
}

export interface DepartmentResponse {
  department: Department;
}

/** A leave type as HR sees it: inactive ones included. */
export interface HrLeaveType extends LeaveType {
  isActive: boolean;
  /** Requests of this type (any status). */
  requestCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HrLeaveTypesResponse {
  leaveTypes: HrLeaveType[];
}

export interface HrLeaveTypeResponse {
  leaveType: HrLeaveType;
}

export interface Holiday {
  id: string;
  /** "YYYY-MM-DD" */
  date: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface HolidaysResponse {
  holidays: Holiday[];
}

/**
 * Active requests (PENDING/APPROVED) crossing a date: they are not
 * recalculated when a holiday is added or removed there. All zeros on a
 * weekend, which never counted as a business day. The breakdown is what HR
 * uses to decide on balance adjustments (by each request's own copy of
 * "descuenta", and whether it already ended).
 */
export interface HolidayImpact {
  affectedRequests: number;
  breakdown: {
    countingBalance: number;
    notCountingBalance: number;
    /** Already over (ended before today). */
    past: number;
    /** Running or in the future. */
    upcoming: number;
  };
}

export interface CreatedHolidayResponse extends HolidayImpact {
  holiday: Holiday;
}
