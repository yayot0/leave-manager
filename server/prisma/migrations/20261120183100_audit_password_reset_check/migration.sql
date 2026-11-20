-- RH-B1: PASSWORD_RESET entries carry both snapshots (mustChangePassword and
-- passwordChangedAt before and after; never the password). Separate from
-- accounts_passwords because the enum value must be committed before a
-- CHECK can reference it.

ALTER TABLE "hr_audit_logs" DROP CONSTRAINT "chk_hr_audit_logs_snapshots_match_action";

ALTER TABLE "hr_audit_logs"
  ADD CONSTRAINT "chk_hr_audit_logs_snapshots_match_action"
  CHECK (
    (
      "action" = 'CREATED'::"HrAuditAction"
      AND "before" IS NULL
      AND "after" IS NOT NULL
    )
    OR (
      "action" = 'DELETED'::"HrAuditAction"
      AND "before" IS NOT NULL
      AND "after" IS NULL
    )
    OR (
      "action" IN (
        'UPDATED'::"HrAuditAction",
        'DEACTIVATED'::"HrAuditAction",
        'REACTIVATED'::"HrAuditAction",
        'PASSWORD_RESET'::"HrAuditAction"
      )
      AND "before" IS NOT NULL
      AND "after" IS NOT NULL
    )
  );

-- PASSWORD_RESET is always about an employee and its snapshots hold exactly
-- mustChangePassword and passwordChangedAt: a whitelist enforced by the
-- database, because an entry that leaked a secret could never be deleted.
-- A reset always leaves the password temporary (after.mustChangePassword).
-- before/after are NOT NULL here thanks to the CHECK above (with NULL, ?&
-- would yield NULL and the CHECK would pass).
ALTER TABLE "hr_audit_logs"
  ADD CONSTRAINT "chk_hr_audit_logs_password_reset_shape"
  CHECK (
    "action" <> 'PASSWORD_RESET'::"HrAuditAction"
    OR (
      "entity_type" = 'EMPLOYEE'::"HrAuditEntity"
      AND "before" ?& ARRAY['mustChangePassword', 'passwordChangedAt']
      AND "after" ?& ARRAY['mustChangePassword', 'passwordChangedAt']
      AND ("before" - 'mustChangePassword' - 'passwordChangedAt') = '{}'::jsonb
      AND ("after" - 'mustChangePassword' - 'passwordChangedAt') = '{}'::jsonb
      AND "after" -> 'mustChangePassword' = 'true'::jsonb
    )
  );
