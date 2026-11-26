import type { EmployeeFilters } from "./types";

/**
 * Every query key in one place, so invalidations can't drift from the keys
 * the queries use. Everything about leave requests lives under
 * ["leave-requests"], so a single prefix invalidation refreshes the list,
 * the details, the previews and the pending approvals at once.
 */
export interface PreviewInput {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
}

export const queryKeys = {
  balance: ["me", "balance"] as const,
  leaveTypes: ["leave-types"] as const,
  leaveRequests: ["leave-requests"] as const,
  myLeaveRequests: ["leave-requests", "mine"] as const,
  pendingApprovals: ["leave-requests", "pending-approvals"] as const,
  leaveRequestDetail: (id: string) => ["leave-requests", "detail", id] as const,
  leaveRequestPreviews: ["leave-requests", "preview"] as const,
  leaveRequestPreview: (input: PreviewInput) => ["leave-requests", "preview", input] as const,
  // HR catalogs live under ["hr"]: cleared with everything else on a user change.
  hrDepartments: ["hr", "departments"] as const,
  hrLeaveTypes: ["hr", "leave-types"] as const,
  hrHolidays: ["hr", "holidays"] as const,
  hrHolidaysOfYear: (year: number) => ["hr", "holidays", year] as const,
  // Not under ["hr", "holidays"]: refreshing the list must not refetch the
  // impact of the dialog that is closing.
  hrHolidayImpact: (date: string) => ["hr", "holiday-impact", date] as const,
  // Employees: the list pages and each detail under ["hr","employees"], so
  // one prefix invalidation refreshes both after any change.
  hrEmployees: ["hr", "employees"] as const,
  hrEmployeeList: (filters: EmployeeFilters) => ["hr", "employees", "list", filters] as const,
  hrEmployeeDetail: (id: string) => ["hr", "employees", "detail", id] as const,
  hrManagerOptions: ["hr", "employees", "manager-options"] as const,
  // Previews outside the prefix: refreshing the employee must not refetch
  // the preview of the dialog that is closing (same as hrHolidayImpact).
  hrHireDateImpact: (id: string, hireDate: string) => ["hr", "hire-date-impact", id, hireDate] as const,
  hrDeactivationImpact: (id: string) => ["hr", "deactivation-impact", id] as const,
};
