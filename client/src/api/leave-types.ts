import { apiFetch } from "./client";
import type { LeaveType, LeaveTypesResponse } from "./types";

export async function listLeaveTypes(signal?: AbortSignal): Promise<LeaveType[]> {
  const { leaveTypes } = await apiFetch<LeaveTypesResponse>("/leave-types", { signal });
  return leaveTypes;
}
