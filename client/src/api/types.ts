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
  countsAgainstVacationBalance: boolean;
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

/** GET /leave-requests/:id (also returned by approve/reject/cancel). */
export interface LeaveRequestDetail extends Omit<LeaveRequest, "permissions"> {
  updatedAt: string;
  requester: Person;
  decider: Person | null;
  events: RequestEvent[];
  isOverdue: boolean;
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
