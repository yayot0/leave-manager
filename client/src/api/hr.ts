import { apiFetch } from "./client";
import type {
  CreatedHolidayResponse,
  Department,
  DepartmentResponse,
  DepartmentsResponse,
  Holiday,
  HolidayImpact,
  HolidaysResponse,
  HrLeaveType,
  HrLeaveTypeResponse,
  HrLeaveTypesResponse,
} from "./types";

// Ids always go through encodeURIComponent (see CLAUDE.md).
const departmentPath = (id: string) => `/hr/departments/${encodeURIComponent(id)}`;
const leaveTypePath = (id: string) => `/hr/leave-types/${encodeURIComponent(id)}`;
const holidayPath = (id: string) => `/hr/holidays/${encodeURIComponent(id)}`;

// ---------- Departments ----------

export async function listDepartments(signal?: AbortSignal): Promise<Department[]> {
  const { departments } = await apiFetch<DepartmentsResponse>("/hr/departments", { signal });
  return departments;
}

export async function createDepartment(name: string): Promise<Department> {
  const { department } = await apiFetch<DepartmentResponse>("/hr/departments", { method: "POST", body: { name } });
  return department;
}

export async function renameDepartment(id: string, name: string): Promise<Department> {
  const { department } = await apiFetch<DepartmentResponse>(departmentPath(id), { method: "PATCH", body: { name } });
  return department;
}

export async function deleteDepartment(id: string): Promise<void> {
  await apiFetch<null>(departmentPath(id), { method: "DELETE" });
}

// ---------- Leave types ----------

export interface LeaveTypeInput {
  name: string;
  countsAgainstVacationBalance: boolean;
  /** null = no limit. */
  maxBusinessDaysPerRequest: number | null;
}

export interface CreateLeaveTypeInput extends LeaveTypeInput {
  code: string;
}

/**
 * `code` is never sent: it cannot be edited. `expectedUpdatedAt` is the
 * `updatedAt` the form loaded: if someone saved since, the API answers 409
 * STALE_DATA instead of overwriting their change.
 */
export type UpdateLeaveTypeInput = Partial<LeaveTypeInput & { isActive: boolean }> & { expectedUpdatedAt?: string };

export async function listHrLeaveTypes(signal?: AbortSignal): Promise<HrLeaveType[]> {
  const { leaveTypes } = await apiFetch<HrLeaveTypesResponse>("/hr/leave-types", { signal });
  return leaveTypes;
}

export async function createLeaveType(input: CreateLeaveTypeInput): Promise<HrLeaveType> {
  const { leaveType } = await apiFetch<HrLeaveTypeResponse>("/hr/leave-types", { method: "POST", body: input });
  return leaveType;
}

export async function updateLeaveType(id: string, input: UpdateLeaveTypeInput): Promise<HrLeaveType> {
  const { leaveType } = await apiFetch<HrLeaveTypeResponse>(leaveTypePath(id), { method: "PATCH", body: input });
  return leaveType;
}

// ---------- Holidays ----------

export async function listHolidays(year: number, signal?: AbortSignal): Promise<Holiday[]> {
  const query = new URLSearchParams({ year: String(year) });
  const { holidays } = await apiFetch<HolidaysResponse>(`/hr/holidays?${query}`, { signal });
  return holidays;
}

export async function getHolidayImpact(date: string, signal?: AbortSignal): Promise<HolidayImpact> {
  const query = new URLSearchParams({ date });
  return apiFetch<HolidayImpact>(`/hr/holidays/impact?${query}`, { signal });
}

export async function createHoliday(input: { date: string; name: string }): Promise<CreatedHolidayResponse> {
  return apiFetch<CreatedHolidayResponse>("/hr/holidays", { method: "POST", body: input });
}

export async function deleteHoliday(id: string): Promise<HolidayImpact> {
  return apiFetch<HolidayImpact>(holidayPath(id), { method: "DELETE" });
}
