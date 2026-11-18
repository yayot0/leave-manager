import { apiFetch } from "./client";
import type {
  CreatedLeaveRequestResponse,
  LeaveRequest,
  LeaveRequestDetail,
  LeaveRequestDetailResponse,
  LeaveRequestPreview,
  LeaveRequestPreviewResponse,
  LeaveRequestsResponse,
  PendingApproval,
  PendingApprovalsResponse,
} from "./types";
import type { PreviewInput } from "./query-keys";

export interface CreateLeaveRequestInput extends PreviewInput {
  reason?: string;
}

// Ids always go through encodeURIComponent: a crafted id like "../me/balance"
// would otherwise be normalized by `new URL` into another endpoint.
const requestPath = (id: string) => `/leave-requests/${encodeURIComponent(id)}`;

export async function listMyLeaveRequests(signal?: AbortSignal): Promise<LeaveRequest[]> {
  const { leaveRequests } = await apiFetch<LeaveRequestsResponse>("/leave-requests/mine", { signal });
  return leaveRequests;
}

export async function listPendingApprovals(signal?: AbortSignal): Promise<PendingApproval[]> {
  const { leaveRequests } = await apiFetch<PendingApprovalsResponse>("/leave-requests/pending-approvals", { signal });
  return leaveRequests;
}

export async function getLeaveRequest(id: string, signal?: AbortSignal): Promise<LeaveRequestDetail> {
  const { leaveRequest } = await apiFetch<LeaveRequestDetailResponse>(requestPath(id), { signal });
  return leaveRequest;
}

export async function previewLeaveRequest(input: PreviewInput, signal?: AbortSignal): Promise<LeaveRequestPreview> {
  // Exactly these three parameters: the API rejects unknown ones.
  const query = new URLSearchParams({
    leaveTypeId: input.leaveTypeId,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const { preview } = await apiFetch<LeaveRequestPreviewResponse>(`/leave-requests/preview?${query}`, { signal });
  return preview;
}

export async function createLeaveRequest(input: CreateLeaveRequestInput): Promise<LeaveRequest> {
  const { leaveRequest } = await apiFetch<CreatedLeaveRequestResponse>("/leave-requests", {
    method: "POST",
    body: input,
  });
  return leaveRequest;
}

export async function cancelLeaveRequest(id: string, note?: string): Promise<LeaveRequestDetail> {
  const { leaveRequest } = await apiFetch<LeaveRequestDetailResponse>(`${requestPath(id)}/cancel`, {
    method: "POST",
    body: note ? { note } : {},
  });
  return leaveRequest;
}

export async function approveLeaveRequest(id: string, note?: string): Promise<LeaveRequestDetail> {
  const { leaveRequest } = await apiFetch<LeaveRequestDetailResponse>(`${requestPath(id)}/approve`, {
    method: "POST",
    body: note ? { note } : {},
  });
  return leaveRequest;
}

/** The API requires a non-empty note to reject. */
export async function rejectLeaveRequest(id: string, note: string): Promise<LeaveRequestDetail> {
  const { leaveRequest } = await apiFetch<LeaveRequestDetailResponse>(`${requestPath(id)}/reject`, {
    method: "POST",
    body: { note },
  });
  return leaveRequest;
}
