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
};
