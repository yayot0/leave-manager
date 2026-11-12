import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { AUTH_COOKIE_NAME } from "../auth/cookie.js";
import { authCookie, createLeaveType, createUser, prisma, resetDb } from "../../test/db.js";

const app = createApp();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T18:00:00Z"));
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/leave-types", () => {
  it("returns 401 without an auth cookie", async () => {
    const res = await request(app).get("/api/leave-types");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it("returns 401 with an invalid auth cookie", async () => {
    const res = await request(app).get("/api/leave-types").set("Cookie", `${AUTH_COOKIE_NAME}=garbage`);
    expect(res.status).toBe(401);
  });

  it("returns only active leave types, ordered by name ascending", async () => {
    const user = await createUser();
    await createLeaveType({ code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true });
    await createLeaveType({ code: "MED", name: "Incapacidad", countsAgainstVacationBalance: false });
    await createLeaveType({ code: "OLD", name: "Antiguo", isActive: false });
    await createLeaveType({ code: "BRV", name: "Bereavement", countsAgainstVacationBalance: false });

    const res = await request(app).get("/api/leave-types").set("Cookie", await authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.leaveTypes.map((t: { name: string }) => t.name)).toEqual([
      "Bereavement",
      "Incapacidad",
      "Vacaciones",
    ]);
    expect(res.body.leaveTypes[0]).toEqual({
      id: expect.any(String),
      code: "BRV",
      name: "Bereavement",
      countsAgainstVacationBalance: false,
    });
  });

  it("does not expose isActive or timestamps", async () => {
    const user = await createUser();
    await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const res = await request(app).get("/api/leave-types").set("Cookie", await authCookie(user.id));
    expect(Object.keys(res.body.leaveTypes[0]).sort()).toEqual(
      ["code", "countsAgainstVacationBalance", "id", "name"],
    );
  });

  it("returns an empty list when every type is inactive", async () => {
    const user = await createUser();
    await createLeaveType({ code: "OLD", isActive: false });
    const res = await request(app).get("/api/leave-types").set("Cookie", await authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leaveTypes: [] });
  });
});
