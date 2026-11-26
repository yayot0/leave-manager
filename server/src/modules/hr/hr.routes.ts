import { Router, type Request } from "express";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { UnauthorizedError } from "../../errors/AppError.js";
import {
  catalogIdSchema,
  createHolidaySchema,
  createLeaveTypeSchema,
  createEmployeeSchema,
  departmentInputSchema,
  employeesQuerySchema,
  employeeStateChangeSchema,
  hireDateImpactQuerySchema,
  holidayImpactQuerySchema,
  holidaysQuerySchema,
  updateEmployeeSchema,
  updateLeaveTypeSchema,
} from "./hr.schemas.js";
import { createDepartment, deleteDepartment, listDepartments, renameDepartment } from "./departments.service.js";
import { createLeaveType, listLeaveTypesForHr, updateLeaveType } from "./leave-types.service.js";
import { createHoliday, deleteHoliday, getHolidayImpact, listHolidays } from "./holidays.service.js";
import {
  createEmployee,
  deactivateEmployee,
  getDeactivationImpact,
  getEmployeeDetail,
  getHireDateImpact,
  listEmployees,
  listManagerOptions,
  reactivateEmployee,
  resetEmployeePassword,
  updateEmployee,
} from "./employees.service.js";
import { resetChangePasswordLimits } from "../auth/rate-limits.js";

/**
 * Everything under /api/hr is for HR only: the role check runs once for the
 * whole router, so a new route cannot forget it. 401 without a session, 403
 * for any other role.
 */
export const hrRouter = Router();

hrRouter.use(requireAuth, requireRole("HR"));

function actorId(req: Request): string {
  if (!req.user) throw new UnauthorizedError();
  return req.user.id;
}

hrRouter.get("/employees/count", async (_req, res) => {
  const count = await prisma.user.count({ where: { role: "EMPLOYEE", isActive: true } });
  res.json({ count });
});

// ---------- Employees ----------
// Static paths (count, manager-options) before "/employees/:id".

hrRouter.get("/employees", async (req, res) => {
  res.json(await listEmployees(employeesQuerySchema.parse(req.query)));
});

hrRouter.get("/employees/manager-options", async (_req, res) => {
  res.json({ managers: await listManagerOptions() });
});

hrRouter.post("/employees", async (req, res) => {
  const input = createEmployeeSchema.parse(req.body ?? {});
  const result = await createEmployee(actorId(req), input);
  // The temporary password is in this body only: no cache may keep it.
  res.set("Cache-Control", "no-store");
  res.status(201).json(result);
});

hrRouter.get("/employees/:id", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  res.json({ employee: await getEmployeeDetail(actorId(req), id) });
});

hrRouter.patch("/employees/:id", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  const input = updateEmployeeSchema.parse(req.body ?? {});
  res.json({ employee: await updateEmployee(actorId(req), id, input) });
});

hrRouter.get("/employees/:id/hire-date-impact", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  const { hireDate } = hireDateImpactQuerySchema.parse(req.query);
  res.json(await getHireDateImpact(id, hireDate));
});

hrRouter.get("/employees/:id/deactivation-impact", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  res.json(await getDeactivationImpact(actorId(req), id));
});

hrRouter.post("/employees/:id/deactivate", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  const { expectedUpdatedAt } = employeeStateChangeSchema.parse(req.body ?? {});
  res.json(await deactivateEmployee(actorId(req), id, expectedUpdatedAt));
});

hrRouter.post("/employees/:id/reactivate", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  const { expectedUpdatedAt } = employeeStateChangeSchema.parse(req.body ?? {});
  const result = await reactivateEmployee(actorId(req), id, expectedUpdatedAt);
  // Same as a reset: a lockout earned with an old password must not block the new one.
  await resetChangePasswordLimits(id);
  res.set("Cache-Control", "no-store");
  res.json(result);
});

hrRouter.post("/employees/:id/reset-password", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  const result = await resetEmployeePassword(actorId(req), id);
  // After the commit: a lockout earned with the old password must not keep
  // the employee from replacing the new temporary one.
  await resetChangePasswordLimits(id);
  // The temporary password is in this body only: no cache may keep it.
  res.set("Cache-Control", "no-store");
  res.json(result);
});

// ---------- Departments ----------

hrRouter.get("/departments", async (_req, res) => {
  res.json({ departments: await listDepartments() });
});

hrRouter.post("/departments", async (req, res) => {
  const { name } = departmentInputSchema.parse(req.body ?? {});
  res.status(201).json({ department: await createDepartment(actorId(req), name) });
});

hrRouter.patch("/departments/:id", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  const { name } = departmentInputSchema.parse(req.body ?? {});
  res.json({ department: await renameDepartment(actorId(req), id, name) });
});

hrRouter.delete("/departments/:id", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  await deleteDepartment(actorId(req), id);
  res.status(204).end();
});

// ---------- Leave types ----------

hrRouter.get("/leave-types", async (_req, res) => {
  res.json({ leaveTypes: await listLeaveTypesForHr() });
});

hrRouter.post("/leave-types", async (req, res) => {
  const input = createLeaveTypeSchema.parse(req.body ?? {});
  res.status(201).json({ leaveType: await createLeaveType(actorId(req), input) });
});

hrRouter.patch("/leave-types/:id", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  const input = updateLeaveTypeSchema.parse(req.body ?? {});
  res.json({ leaveType: await updateLeaveType(actorId(req), id, input) });
});

// ---------- Holidays ----------

hrRouter.get("/holidays", async (req, res) => {
  const { year } = holidaysQuerySchema.parse(req.query);
  res.json({ holidays: await listHolidays(year) });
});

hrRouter.get("/holidays/impact", async (req, res) => {
  const { date } = holidayImpactQuerySchema.parse(req.query);
  res.json(await getHolidayImpact(prisma, date));
});

hrRouter.post("/holidays", async (req, res) => {
  const input = createHolidaySchema.parse(req.body ?? {});
  res.status(201).json(await createHoliday(actorId(req), input));
});

hrRouter.delete("/holidays/:id", async (req, res) => {
  const id = catalogIdSchema.parse(req.params.id);
  res.json(await deleteHoliday(actorId(req), id));
});
