-- Each leave request keeps a copy of whether its leave type counted against
-- the vacation balance when it was created. Balances read this copy, so
-- editing a leave type later never changes past balances.
--
-- Three steps, because existing rows need a value before NOT NULL:
-- 1. add the column as nullable;
-- 2. backfill it from each request's current leave type (the best
--    information available: until now the balance read exactly that);
-- 3. make it NOT NULL. No DEFAULT on purpose: the application must always
--    set it explicitly when creating a request.

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN "counts_against_vacation_balance" BOOLEAN;

-- backfill (the integration tests run this exact statement: keep it a single
-- UPDATE between the "-- backfill" and "-- end backfill" markers)
UPDATE "leave_requests" AS lr
SET "counts_against_vacation_balance" = lt."counts_against_vacation_balance"
FROM "leave_types" AS lt
WHERE lt."id" = lr."leave_type_id";
-- end backfill

ALTER TABLE "leave_requests" ALTER COLUMN "counts_against_vacation_balance" SET NOT NULL;
