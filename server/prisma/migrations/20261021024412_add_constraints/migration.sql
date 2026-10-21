-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- 1. The end date can never be before the start date.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "chk_leave_requests_dates_valid"
  CHECK ("end_date" >= "start_date");

-- 2. business_days is computed by the app (weekends and holidays excluded);
--    it must always be a positive number of days.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "chk_leave_requests_business_days_positive"
  CHECK ("business_days" > 0);

-- 3. A manager cannot be the decider of their own request.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "chk_leave_requests_decider_not_requester"
  CHECK ("decider_id" IS NULL OR "decider_id" <> "requester_id");

-- 4. A balance adjustment that changes nothing (0 days) is meaningless.
ALTER TABLE "balance_adjustments"
  ADD CONSTRAINT "chk_balance_adjustments_days_not_zero"
  CHECK ("days" <> 0);

-- 5. A single requester cannot have two PENDING/APPROVED requests whose
--    date ranges overlap. REJECTED/CANCELLED requests are excluded from
--    the check so a rejected request doesn't block a new one on those dates.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "excl_leave_requests_no_overlapping_active_ranges"
  EXCLUDE USING gist (
    "requester_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  )
  WHERE ("status" IN ('PENDING'::"LeaveRequestStatus", 'APPROVED'::"LeaveRequestStatus"));
