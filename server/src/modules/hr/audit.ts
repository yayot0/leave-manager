import { Prisma } from "../../generated/prisma/client.js";
import type { HrAuditAction, HrAuditEntity } from "../../generated/prisma/enums.js";

/**
 * A whitelisted, JSON-safe picture of an entity: only the fields listed by
 * each `*AuditSnapshot` function below, with dates as ISO strings. Never
 * pass a raw Prisma row: from RH-B on, a user row carries passwordHash.
 */
export type AuditSnapshot = Record<string, string | number | boolean | null>;

interface AuditEntry {
  actorId: string;
  entityType: HrAuditEntity;
  entityId: string;
  action: HrAuditAction;
  /** null for CREATED. */
  before: AuditSnapshot | null;
  /** null for DELETED. */
  after: AuditSnapshot | null;
}

/**
 * Appends one entry to hr_audit_logs. Takes the transaction client on
 * purpose: the entry is written in the same transaction as the change, so
 * either both are committed or neither is. The table is append-only
 * (database triggers reject UPDATE, DELETE and TRUNCATE).
 */
export async function recordHrAudit(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await tx.hrAuditLog.create({
    data: {
      actorId: entry.actorId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      // Prisma.DbNull stores SQL NULL; a plain null would be JSON null, which
      // chk_hr_audit_logs_snapshots_are_objects rejects.
      before: entry.before ?? Prisma.DbNull,
      after: entry.after ?? Prisma.DbNull,
    },
  });
}
