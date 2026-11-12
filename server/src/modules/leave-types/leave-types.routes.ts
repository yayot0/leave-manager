import { Router } from "express";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../middleware/requireAuth.js";

export const leaveTypesRouter = Router();

leaveTypesRouter.get("/", requireAuth, async (_req, res) => {
  const leaveTypes = await prisma.leaveType.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true, countsAgainstVacationBalance: true },
  });
  res.json({ leaveTypes });
});
