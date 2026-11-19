-- 1. Optional per-request limit of business days for each leave type
--    (NULL = no limit). Validated when a request is created
--    (EXCEEDS_TYPE_LIMIT); lowering it never touches existing requests.
-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN "max_business_days_per_request" INTEGER;

-- Added by hand (Prisma cannot express CHECK constraints): a limit of 0 or
-- less would make the type unusable; "no limit" is NULL.
-- The upper bound only catches typos: a year has about 260 business days.
ALTER TABLE "leave_types"
  ADD CONSTRAINT "chk_leave_types_max_business_days_range"
  CHECK ("max_business_days_per_request" IS NULL OR "max_business_days_per_request" BETWEEN 1 AND 366);

-- 2. A department with employees can no longer be deleted: before, deleting
--    it silently left them without a department (ON DELETE SET NULL). The API
--    answers 409 first; RESTRICT is the second line of defense.
-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_department_id_fkey";

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Added by hand (Prisma cannot express expression indexes): names are
--    unique ignoring case, so "Ventas" and "ventas" cannot coexist. The
--    existing case-sensitive unique indexes stay (Prisma manages them).
CREATE UNIQUE INDEX "uq_departments_name_lower" ON "departments" (lower("name"));
CREATE UNIQUE INDEX "uq_leave_types_name_lower" ON "leave_types" (lower("name"));

-- 4. Added by hand, second line of defense behind Zod: names have no
--    leading/trailing spaces ("Ventas " would dodge the lower(name) index)
--    and a sane length, and leave type codes are uppercase identifiers (the
--    code is unique but case-sensitive, so "vac" and "VAC" could coexist).
ALTER TABLE "departments"
  ADD CONSTRAINT "chk_departments_name_trimmed"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 100);
ALTER TABLE "leave_types"
  ADD CONSTRAINT "chk_leave_types_name_trimmed"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 100);
ALTER TABLE "holidays"
  ADD CONSTRAINT "chk_holidays_name_trimmed"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 100);
ALTER TABLE "leave_types"
  ADD CONSTRAINT "chk_leave_types_code_format"
  CHECK ("code" ~ '^[A-Z][A-Z0-9_]{0,29}$');
