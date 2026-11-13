-- A request's decision fields must match its status:
-- - APPROVED / REJECTED: a MANAGER or HR decided it, so decider_id and
--   decided_at are both set.
-- - PENDING: nobody has decided it yet, so both are NULL.
-- - CANCELLED: both set (it was approved and later cancelled by the employee,
--   who never overwrites decider_id) or both NULL (cancelled while still
--   pending). Never only one of the two.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "chk_leave_requests_decision_matches_status"
  CHECK (
    (
      "status" IN ('APPROVED'::"LeaveRequestStatus", 'REJECTED'::"LeaveRequestStatus")
      AND "decider_id" IS NOT NULL
      AND "decided_at" IS NOT NULL
    )
    OR (
      "status" = 'PENDING'::"LeaveRequestStatus"
      AND "decider_id" IS NULL
      AND "decided_at" IS NULL
    )
    OR (
      "status" = 'CANCELLED'::"LeaveRequestStatus"
      AND ("decider_id" IS NULL) = ("decided_at" IS NULL)
    )
  );
