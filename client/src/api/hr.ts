import { apiFetch } from "./client";
import type {
  CreatedHolidayResponse,
  DeactivationImpact,
  DeactivationResponse,
  Employee,
  EmployeeDetail,
  EmployeeDetailResponse,
  EmployeeFilters,
  EmployeeResponse,
  EmployeesPage,
  EmployeeWithPasswordResponse,
  HireDateImpact,
  ManagerOption,
  ManagerOptionsResponse,
  PasswordResetResponse,
  Role,
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

// ---------- Employees ----------

const employeePath = (id: string) => `/hr/employees/${encodeURIComponent(id)}`;

export interface EmployeeInput {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  departmentId: string;
  /** null = no manager (HR decides their requests). */
  managerId: string | null;
  /** "YYYY-MM-DD" */
  hireDate: string;
}

/** Only the fields that changed, plus the updatedAt the form loaded. */
export type UpdateEmployeeInput = Partial<EmployeeInput> & { expectedUpdatedAt?: string };

/** Only the filters that differ from the defaults go to the API. */
export async function listEmployees(filters: EmployeeFilters, signal?: AbortSignal): Promise<EmployeesPage> {
  const query = new URLSearchParams({ status: filters.status, page: String(filters.page) });
  if (filters.q.trim() !== "") query.set("q", filters.q.trim());
  if (filters.departmentId !== "") query.set("departmentId", filters.departmentId);
  if (filters.role !== "") query.set("role", filters.role);
  return apiFetch<EmployeesPage>(`/hr/employees?${query}`, { signal });
}

export async function getEmployee(id: string, signal?: AbortSignal): Promise<EmployeeDetail> {
  const { employee } = await apiFetch<EmployeeDetailResponse>(employeePath(id), { signal });
  return employee;
}

export async function listManagerOptions(signal?: AbortSignal): Promise<ManagerOption[]> {
  const { managers } = await apiFetch<ManagerOptionsResponse>("/hr/employees/manager-options", { signal });
  return managers;
}

export async function createEmployee(input: EmployeeInput): Promise<EmployeeWithPasswordResponse> {
  return apiFetch<EmployeeWithPasswordResponse>("/hr/employees", { method: "POST", body: input });
}

export async function updateEmployee(id: string, input: UpdateEmployeeInput): Promise<Employee> {
  const { employee } = await apiFetch<EmployeeResponse>(employeePath(id), { method: "PATCH", body: input });
  return employee;
}

export async function getHireDateImpact(id: string, hireDate: string, signal?: AbortSignal): Promise<HireDateImpact> {
  const query = new URLSearchParams({ hireDate });
  return apiFetch<HireDateImpact>(`${employeePath(id)}/hire-date-impact?${query}`, { signal });
}

export async function getDeactivationImpact(id: string, signal?: AbortSignal): Promise<DeactivationImpact> {
  return apiFetch<DeactivationImpact>(`${employeePath(id)}/deactivation-impact`, { signal });
}

export async function deactivateEmployee(id: string, expectedUpdatedAt: string): Promise<DeactivationResponse> {
  return apiFetch<DeactivationResponse>(`${employeePath(id)}/deactivate`, { method: "POST", body: { expectedUpdatedAt } });
}

export async function reactivateEmployee(id: string, expectedUpdatedAt: string): Promise<EmployeeWithPasswordResponse> {
  return apiFetch<EmployeeWithPasswordResponse>(`${employeePath(id)}/reactivate`, {
    method: "POST",
    body: { expectedUpdatedAt },
  });
}

export async function resetEmployeePassword(id: string): Promise<PasswordResetResponse> {
  return apiFetch<PasswordResetResponse>(`${employeePath(id)}/reset-password`, { method: "POST" });
}
