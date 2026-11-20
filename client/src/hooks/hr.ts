import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import {
  createDepartment,
  createHoliday,
  createLeaveType,
  deleteDepartment,
  deleteHoliday,
  getHolidayImpact,
  listDepartments,
  listHolidays,
  listHrLeaveTypes,
  renameDepartment,
  updateLeaveType,
  type CreateLeaveTypeInput,
  type UpdateLeaveTypeInput,
} from "@/api/hr";
import { queryKeys } from "@/api/query-keys";

// ---------- Queries ----------

export function useDepartments() {
  return useQuery({ queryKey: queryKeys.hrDepartments, queryFn: ({ signal }) => listDepartments(signal) });
}

export function useHrLeaveTypes() {
  return useQuery({ queryKey: queryKeys.hrLeaveTypes, queryFn: ({ signal }) => listHrLeaveTypes(signal) });
}

export function useHolidays(year: number) {
  return useQuery({
    queryKey: queryKeys.hrHolidaysOfYear(year),
    queryFn: ({ signal }) => listHolidays(year, signal),
  });
}

/**
 * Active requests that cross `date` (not recalculated if a holiday is added
 * or removed there), with the breakdown HR uses to decide on adjustments.
 * Only asked for a complete date ("YYYY-MM-DD"); the caller debounces typed
 * input, so "0002-…" while typing the year never reaches the API.
 */
export function useHolidayImpact(date: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.hrHolidayImpact(date),
    queryFn: ({ signal }) => getHolidayImpact(date, signal),
    enabled: enabled && /^\d{4}-\d{2}-\d{2}$/.test(date),
  });
}

// ---------- Mutations ----------

/**
 * 404/409 on a catalog action: someone else changed the data meanwhile
 * (deleted it, took the name, assigned an employee), so the list on screen
 * is stale. The dialogs stay mounted, so the error remains readable.
 */
function isStaleCatalogError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 409);
}

/** Same shape for every catalog mutation: refresh what it touched, also after a stale error. */
function useCatalogMutation<TVariables, TResult>(
  action: (variables: TVariables) => Promise<TResult>,
  refresh: (queryClient: QueryClient) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSuccess: () => refresh(queryClient),
    onError: (error) => {
      if (isStaleCatalogError(error)) refresh(queryClient);
    },
  });
}

function refreshDepartments(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.hrDepartments });
}

/**
 * A leave type change also affects the employees' catalog (the new-request
 * form). Everything under ["leave-requests"] (lists, details, approvals,
 * previews) carries the type's name and is only marked stale: the next
 * screen that shows it gets it fresh (same reason as invalidateLeaveData).
 */
function refreshLeaveTypes(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.hrLeaveTypes });
  void queryClient.invalidateQueries({ queryKey: queryKeys.leaveTypes });
  void queryClient.invalidateQueries({ queryKey: queryKeys.leaveRequests, refetchType: "none" });
}

/** Holidays change business days of new requests: previews are marked stale too. */
function refreshHolidays(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.hrHolidays });
  void queryClient.invalidateQueries({ queryKey: queryKeys.leaveRequestPreviews, refetchType: "none" });
}

/** Creates a department, or renames it when `id` is given: one mutation per form dialog. */
export function useSaveDepartment(id?: string) {
  return useCatalogMutation(
    (name: string) => (id === undefined ? createDepartment(name) : renameDepartment(id, name)),
    refreshDepartments,
  );
}

export function useDeleteDepartment() {
  return useCatalogMutation((id: string) => deleteDepartment(id), refreshDepartments);
}

export type SaveLeaveTypeVariables =
  | { kind: "create"; input: CreateLeaveTypeInput }
  /** Only the fields that changed, plus expectedUpdatedAt; never `code`. */
  | { kind: "update"; id: string; input: UpdateLeaveTypeInput };

/** Creates or edits a leave type: one mutation per form dialog. */
export function useSaveLeaveType() {
  return useCatalogMutation(
    (variables: SaveLeaveTypeVariables) =>
      variables.kind === "create" ? createLeaveType(variables.input) : updateLeaveType(variables.id, variables.input),
    refreshLeaveTypes,
  );
}

/** Deactivate / reactivate (or any partial edit). */
export function useUpdateLeaveType() {
  return useCatalogMutation(
    ({ id, input }: { id: string; input: UpdateLeaveTypeInput }) => updateLeaveType(id, input),
    refreshLeaveTypes,
  );
}

export function useCreateHoliday() {
  return useCatalogMutation((input: { date: string; name: string }) => createHoliday(input), refreshHolidays);
}

export function useDeleteHoliday() {
  return useCatalogMutation((id: string) => deleteHoliday(id), refreshHolidays);
}
