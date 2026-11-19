-- Append-only log of HR changes (catalogs now; employees and balances in
-- RH-B). The application writes each entry in the same transaction as the
-- change it records.

-- CreateEnum
CREATE TYPE "HrAuditEntity" AS ENUM ('DEPARTMENT', 'LEAVE_TYPE', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "HrAuditAction" AS ENUM ('CREATED', 'UPDATED', 'DEACTIVATED', 'REACTIVATED', 'DELETED');

-- CreateTable
CREATE TABLE "hr_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "entity_type" "HrAuditEntity" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" "HrAuditAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_audit_logs_entity_type_entity_id_created_at_idx" ON "hr_audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "hr_audit_logs_actor_id_idx" ON "hr_audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "hr_audit_logs_created_at_idx" ON "hr_audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "hr_audit_logs" ADD CONSTRAINT "hr_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- Added by hand (Prisma cannot express these) ----------

-- The snapshots must match the action: nothing existed before a creation,
-- nothing exists after a deletion, and any other change has both sides.
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
      "action" IN ('UPDATED'::"HrAuditAction", 'DEACTIVATED'::"HrAuditAction", 'REACTIVATED'::"HrAuditAction")
      AND "before" IS NOT NULL
      AND "after" IS NOT NULL
    )
  );

-- Snapshots are JSON objects: a JSON null ('null'::jsonb, which is not SQL
-- NULL) or a bare string would slip past the CHECK above.
ALTER TABLE "hr_audit_logs"
  ADD CONSTRAINT "chk_hr_audit_logs_snapshots_are_objects"
  CHECK (
    ("before" IS NULL OR jsonb_typeof("before") = 'object')
    AND ("after" IS NULL OR jsonb_typeof("after") = 'object')
  );

-- Immutability: an audit entry is never edited or deleted.
-- ERRCODE insufficient_privilege (42501): the same SQLSTATE Postgres gives
-- when a role lacks the privilege, so the behavior is the same whether the
-- trigger or a missing GRANT stops it.
CREATE FUNCTION "hr_audit_logs_reject_changes"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hr_audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "trg_hr_audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "hr_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "hr_audit_logs_reject_changes"();

-- Row triggers do not fire on TRUNCATE (including a TRUNCATE ... CASCADE
-- from users), so a statement trigger blocks it too, unless the transaction
-- opted in with set_config('app.allow_audit_truncate', 'on', true). Only the
-- test reset and the dev seed do that. A database owner can still disable
-- triggers: in production the app must use a non-owner role without
-- TRUNCATE (see "Pendientes técnicos" in CLAUDE.md).
CREATE FUNCTION "hr_audit_logs_guard_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.allow_audit_truncate', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hr_audit_logs is append-only: TRUNCATE is not allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_hr_audit_logs_no_truncate"
  BEFORE TRUNCATE ON "hr_audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "hr_audit_logs_guard_truncate"();
