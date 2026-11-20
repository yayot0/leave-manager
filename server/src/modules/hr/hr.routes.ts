import { Router, type Request } from "express";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { UnauthorizedError } from "../../errors/AppError.js";
import {
  catalogIdSchema,
  createHolidaySchema,
  createLeaveTypeSchema,
  departmentInputSchema,
  holidayImpactQuerySchema,
  holidaysQuerySchema,
  updateLeaveTypeSchema,
} from "./hr.schemas.js";
import { createDepartment, deleteDepartment, listDepartments, renameDepartment } from "./departments.service.js";
import { createLeaveType, listLeaveTypesForHr, updateLeaveType } from "./leave-types.service.js";
import { createHoliday, deleteHoliday, getHolidayImpact, listHolidays } from "./holidays.service.js";

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
