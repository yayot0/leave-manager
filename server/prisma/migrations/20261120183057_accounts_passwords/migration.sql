-- RH-B1: temporary passwords and session invalidation.
-- New enum values go in their own migration: Postgres cannot use a value
-- added by ALTER TYPE ... ADD VALUE in the same transaction, and the CHECK
-- that uses PASSWORD_RESET lives in audit_password_reset_check.
-- Existing rows get password_changed_at = now(): tokens without the new
-- claim are rejected anyway, so everyone logs in again once.

-- AlterEnum
ALTER TYPE "HrAuditAction" ADD VALUE 'PASSWORD_RESET';

-- AlterEnum
ALTER TYPE "HrAuditEntity" ADD VALUE 'EMPLOYEE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
