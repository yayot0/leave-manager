import { Router } from "express";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { UnauthorizedError } from "../../errors/AppError.js";
import { todayInTimeZone, toISODate } from "../../domain/dates.js";
import { getVacationBalance } from "../balance/balance.service.js";

export const meRouter = Router();

meRouter.get("/balance", requireAuth, async (req, res) => {
  if (!req.user) throw new UnauthorizedError();
  const asOf = todayInTimeZone(env.APP_TIMEZONE);
  const balance = await getVacationBalance(prisma, req.user, asOf);

  res.json({
    balance: {
      ...balance,
      asOf: toISODate(asOf),
      period: { start: toISODate(balance.period.start), end: toISODate(balance.period.end) },
    },
  });
});
