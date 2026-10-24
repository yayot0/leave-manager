import { Router } from "express";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";

export const hrRouter = Router();

hrRouter.get("/employees/count", requireAuth, requireRole("HR"), async (_req, res) => {
  const count = await prisma.user.count({ where: { role: "EMPLOYEE", isActive: true } });
  res.json({ count });
});
