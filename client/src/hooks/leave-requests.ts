import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getMyBalance } from "@/api/balance";
import { ApiError } from "@/api/client";
import { listLeaveTypes } from "@/api/leave-types";
import {
  cancelLeaveRequest,
  createLeaveRequest,
  getLeaveRequest,
  listMyLeaveRequests,
  listPendingApprovals,
  previewLeaveRequest,
} from "@/api/leave-requests";
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

/** 409/404 on an action: the request changed (or vanished) meanwhile, so what is on screen is stale. */
export function isStaleRequestError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 404);
}

export function useCancelLeaveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => cancelLeaveRequest(id, note),
    onSuccess: (detail) => {
      // The API answers with the updated detail: show it right away, without
      // fetching it again.
      queryClient.setQueryData(queryKeys.leaveRequestDetail(detail.id), detail);
      invalidateLeaveData(queryClient, detail.id);
    },
    onError: (error) => {
      // Safe to refresh right away: CancelRequestDialog stays mounted while
      // open, so the error remains readable even if the trigger goes away.
      if (isStaleRequestError(error)) {
        invalidateLeaveData(queryClient);
      }
    },
  });
}
