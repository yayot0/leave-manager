import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getMyBalance } from "@/api/balance";
import { ApiError } from "@/api/client";
import { listLeaveTypes } from "@/api/leave-types";
import {
  approveLeaveRequest,
  cancelLeaveRequest,
  createLeaveRequest,
  getLeaveRequest,
  listMyLeaveRequests,
  listPendingApprovals,
  previewLeaveRequest,
  rejectLeaveRequest,
} from "@/api/leave-requests";
import type { LeaveRequestDetail } from "@/api/types";
import { queryKeys, type PreviewInput } from "@/api/query-keys";
import { useDebouncedValue } from "./use-debounced-value";

export function useBalance() {
  return useQuery({ queryKey: queryKeys.balance, queryFn: ({ signal }) => getMyBalance(signal) });
}

export function useLeaveTypes() {
  return useQuery({
    queryKey: queryKeys.leaveTypes,
    queryFn: ({ signal }) => listLeaveTypes(signal),
    // Catalog data: changes rarely.
    staleTime: 10 * 60 * 1000,
  });
}

export function useMyLeaveRequests() {
  return useQuery({ queryKey: queryKeys.myLeaveRequests, queryFn: ({ signal }) => listMyLeaveRequests(signal) });
}

/**
 * Requests the current user can decide. Shared by the Aprobaciones page and
 * the menu counter (same key, so one fetch serves both). `enabled: false`
 * for roles that never decide, so they do not call the endpoint at all.
 */
export function usePendingApprovals({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.pendingApprovals,
    queryFn: ({ signal }) => listPendingApprovals(signal),
    enabled,
  });
}

export function useLeaveRequest(id: string) {
  return useQuery({
    queryKey: queryKeys.leaveRequestDetail(id),
    queryFn: ({ signal }) => getLeaveRequest(id, signal),
  });
}

export const PREVIEW_DEBOUNCE_MS = 300;

/**
 * Server-side preview of a new request (business days, balance after it,
 * problems). Waits until the three fields are filled and the user stopped
 * typing, and keeps showing the previous result while the next one loads.
 *
 * Each field is debounced on its own, as a string: strings compare by value,
 * so a caller passing a fresh `{…}` on every render cannot restart the timer
 * (an object would, because effects compare dependencies by reference).
 */
export function useLeaveRequestPreview(input: PreviewInput) {
  const leaveTypeId = useDebouncedValue(input.leaveTypeId, PREVIEW_DEBOUNCE_MS);
  const startDate = useDebouncedValue(input.startDate, PREVIEW_DEBOUNCE_MS);
  const endDate = useDebouncedValue(input.endDate, PREVIEW_DEBOUNCE_MS);
  const debounced = { leaveTypeId, startDate, endDate };
  const query = useQuery({
    // TanStack compares keys by content, so a new object here is fine.
    queryKey: queryKeys.leaveRequestPreview(debounced),
    queryFn: ({ signal }) => previewLeaveRequest(debounced, signal),
    enabled: Boolean(leaveTypeId && startDate && endDate),
    placeholderData: keepPreviousData,
  });
  // What is on screen belongs to other values: still debouncing, or showing
  // the previous result while the new one loads.
  const isOutdated =
    query.isPlaceholderData ||
    input.leaveTypeId !== leaveTypeId ||
    input.startDate !== startDate ||
    input.endDate !== endDate;
  return { query, isOutdated };
}

type QueryLike = { queryKey: readonly unknown[] };
const isPreviewQuery = (query: QueryLike) => query.queryKey[1] === queryKeys.leaveRequestPreviews[1];
const isDetailOf = (query: QueryLike, id: string) => query.queryKey[1] === "detail" && query.queryKey[2] === id;

/**
 * After a request is created or changes state, the list, every detail, the
 * pending approvals and the balance may be out of date: refetch the ones on
 * screen. Previews are only marked stale (`refetchType: "none"`): the form
 * that is open has just been sent, and recomputing its preview now would
 * flash "overlaps with another request" — the one just created. Next time
 * the form opens it fetches a fresh one.
 *
 * Not awaited by the mutations, so navigating or closing a dialog does not
 * wait for these refetches. `freshDetailId`: a detail the caller just stored
 * from the API's answer, so there is no need to fetch it again.
 */
export function invalidateLeaveData(queryClient: QueryClient, freshDetailId?: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.leaveRequestPreviews, refetchType: "none" });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.leaveRequests,
    predicate: (query) =>
      !isPreviewQuery(query) && !(freshDetailId !== undefined && isDetailOf(query, freshDetailId)),
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.balance });
}

export function useCreateLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createLeaveRequest,
    onSuccess: () => invalidateLeaveData(queryClient),
  });
}

/**
 * 409: the request changed state meanwhile, so retrying the same action can
 * never succeed. The dialogs then disable their confirm button and leave
 * only "Volver".
 */
export function isConflictError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/**
 * Errors after which what is on screen is stale and worth refreshing behind
 * the dialog: the request changed state (409) or vanished (404), the user may
 * no longer decide it (403), or the balance changed (422).
 */
function shouldRefreshAfter(error: unknown): boolean {
  return error instanceof ApiError && [403, 404, 409, 422].includes(error.status);
}

/**
 * Shared shape of approve/reject/cancel: the API answers with the updated
 * detail, which is shown right away (no refetch), and everything else that
 * depends on the request is refreshed. On a "stale" error the data is
 * refreshed too: the dialogs stay mounted while open, so the error remains
 * readable even if the trigger goes away.
 */
function useRequestActionMutation<TVariables>(action: (variables: TVariables) => Promise<LeaveRequestDetail>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.leaveRequestDetail(detail.id), detail);
      invalidateLeaveData(queryClient, detail.id);
    },
    onError: (error) => {
      if (shouldRefreshAfter(error)) {
        invalidateLeaveData(queryClient);
      }
    },
  });
}

export function useCancelLeaveRequest() {
  return useRequestActionMutation(({ id, note }: { id: string; note?: string }) => cancelLeaveRequest(id, note));
}

export type Decision = "approve" | "reject";

/**
 * Approve or reject, one mutation per dialog. `note` is "" for no note: the
 * approve call then sends none; for reject the dialog never lets it be empty
 * (and the API would answer 400 anyway).
 */
export function useDecideLeaveRequest(decision: Decision) {
  return useRequestActionMutation(({ id, note }: { id: string; note: string }) =>
    decision === "approve" ? approveLeaveRequest(id, note || undefined) : rejectLeaveRequest(id, note),
  );
}
