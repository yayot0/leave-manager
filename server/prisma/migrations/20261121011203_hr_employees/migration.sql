-- RH-B2: employee administration. Only CHECK constraints added by hand
-- (Prisma cannot express them); no enum changes, since EMPLOYEE and the
-- CREATED/UPDATED/DEACTIVATED/REACTIVATED actions already exist.
-- Existing rows were verified to satisfy every constraint before writing it.

-- Nobody is their own manager. With a self-reference hasActiveManager() is
-- true and nobody could ever decide their requests. Longer cycles
-- (A -> B -> A) cannot be expressed as a CHECK: the service rejects them
-- under the employee-directory advisory lock (see server/src/db/locks.ts).
ALTER TABLE "users"
  ADD CONSTRAINT "chk_users_not_own_manager"
  CHECK ("manager_id" IS NULL OR "manager_id" <> "id");

-- Emails are stored normalized (trimmed, lowercase), as login and the API
-- already do. With every row normalized, the existing UNIQUE index on email
-- behaves as case-insensitive: "Ana@x.com" and "ana@x.com" cannot coexist.
ALTER TABLE "users"
  ADD CONSTRAINT "chk_users_email_normalized"
  CHECK ("email" = lower(btrim("email")) AND char_length("email") BETWEEN 3 AND 254);

-- Same rule as the HR catalog names.
ALTER TABLE "users"
  ADD CONSTRAINT "chk_users_first_name_trimmed"
  CHECK ("first_name" = btrim("first_name") AND char_length("first_name") BETWEEN 1 AND 100);

ALTER TABLE "users"
  ADD CONSTRAINT "chk_users_last_name_trimmed"
  CHECK ("last_name" = btrim("last_name") AND char_length("last_name") BETWEEN 1 AND 100);

-- A hire date outside 1950..2100 is a typo, and absurd years break the LFT
-- period math. The API also caps it at one year ahead of today.
ALTER TABLE "users"
  ADD CONSTRAINT "chk_users_hire_date_range"
  CHECK ("hire_date" BETWEEN DATE '1950-01-01' AND DATE '2100-12-31');

-- An audit snapshot never carries a secret. The service whitelists the
-- fields; this is the last line of defense, because an entry that leaked a
-- password could never be deleted (the table is append-only). Only
-- top-level keys are checked (case-sensitive, hence both spellings of the
-- hash): snapshots are flat objects by design.
ALTER TABLE "hr_audit_logs"
  ADD CONSTRAINT "chk_hr_audit_logs_no_secrets"
  CHECK (
    NOT (coalesce("before", '{}'::jsonb) ?| ARRAY['passwordHash', 'password_hash', 'password', 'temporaryPassword'])
    AND NOT (coalesce("after", '{}'::jsonb) ?| ARRAY['passwordHash', 'password_hash', 'password', 'temporaryPassword'])
  );
