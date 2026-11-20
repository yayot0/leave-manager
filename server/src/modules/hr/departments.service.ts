import { prisma } from "../../db/prisma.js";
import { lockDepartment } from "../../db/locks.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../db/pg-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../../errors/AppError.js";
import { recordHrAudit, type AuditSnapshot } from "./audit.js";
import { withCode } from "./errors.js";

const NOT_FOUND = "Departamento no encontrado";
const DUPLICATE_NAME = "Ya existe un departamento con ese nombre";
const HAS_EMPLOYEES = "No se puede borrar un departamento con empleados; reasígnalos primero";

const departmentSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  // Active AND inactive employees: either one blocks the delete.
  _count: { select: { users: true } },
} satisfies Prisma.DepartmentSelect;

type DepartmentRow = Prisma.DepartmentGetPayload<{ select: typeof departmentSelect }>;

function serialize(row: DepartmentRow) {
  const { _count, ...rest } = row;
  return { ...rest, employeeCount: _count.users };
}

function snapshot(row: { id: string; name: string }): AuditSnapshot {
  return { id: row.id, name: row.name };
}

/**
 * Same rule as uq_departments_name_lower (lower(name)); raw SQL on purpose,
 * since Prisma's `mode: "insensitive"` compares with ILIKE, not lower().
 * The unique index is still the real guarantee under concurrency.
 */
async function nameTaken(tx: Prisma.TransactionClient, name: string, exceptId?: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM departments WHERE lower(name) = lower(${name}) AND id <> ${exceptId ?? ""} LIMIT 1`;
  return rows.length > 0;
}

function duplicateName(): ConflictError {
  return withCode(new ConflictError(DUPLICATE_NAME), "DUPLICATE_NAME");
}

export async function listDepartments() {
  const rows = await prisma.department.findMany({ orderBy: { name: "asc" }, select: departmentSelect });
  return rows.map(serialize);
}

export async function createDepartment(actorId: string, name: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      if (await nameTaken(tx, name)) {
        throw duplicateName();
      }
      const created = await tx.department.create({ data: { name }, select: departmentSelect });
      await recordHrAudit(tx, {
        actorId,
        entityType: "DEPARTMENT",
        entityId: created.id,
        action: "CREATED",
        before: null,
        after: snapshot(created),
      });
      return serialize(created);
    });
  } catch (err) {
    // A concurrent create won the race past the pre-check.
    if (isUniqueViolation(err)) throw duplicateName();
    throw err;
  }
}

export async function renameDepartment(actorId: string, id: string, name: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockDepartment(tx, id);
      const current = await tx.department.findUnique({ where: { id }, select: departmentSelect });
      if (!current) {
        throw new NotFoundError(NOT_FOUND);
      }
      // Same name: nothing changes, so nothing is logged.
      if (current.name === name) {
        return serialize(current);
      }
      if (await nameTaken(tx, name, id)) {
        throw duplicateName();
      }
      const updated = await tx.department.update({ where: { id }, data: { name }, select: departmentSelect });
      await recordHrAudit(tx, {
        actorId,
        entityType: "DEPARTMENT",
        entityId: id,
        action: "UPDATED",
        before: snapshot(current),
        after: snapshot(updated),
      });
      return serialize(updated);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateName();
    throw err;
  }
}

/**
 * Only an empty department (no employees, active or not) can be deleted:
 * one with employees would leave them without a department. The audit log
 * keeps the record that it existed.
 */
export async function deleteDepartment(actorId: string, id: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await lockDepartment(tx, id);
      const current = await tx.department.findUnique({ where: { id }, select: departmentSelect });
      if (!current) {
        throw new NotFoundError(NOT_FOUND);
      }
      if (current._count.users > 0) {
        throw withCode(new ConflictError(HAS_EMPLOYEES), "DEPARTMENT_HAS_EMPLOYEES");
      }
      await tx.department.delete({ where: { id } });
      await recordHrAudit(tx, {
        actorId,
        entityType: "DEPARTMENT",
        entityId: id,
        action: "DELETED",
        before: snapshot(current),
        after: null,
      });
    });
  } catch (err) {
    // An employee was assigned meanwhile: ON DELETE RESTRICT stops it.
    if (isForeignKeyViolation(err, "users_department_id_fkey")) {
      throw withCode(new ConflictError(HAS_EMPLOYEES), "DEPARTMENT_HAS_EMPLOYEES");
    }
    throw err;
  }
}
