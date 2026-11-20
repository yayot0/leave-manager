import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { isTransactionTimeout } from "../db/pg-errors.js";
import { ConflictError } from "../errors/AppError.js";
import { errorHandler } from "./errorHandler.js";

/** Mini app whose only route throws `err`, with the real errorHandler. */
function appThrowing(err: unknown) {
  const app = express();
  app.use(express.json());
  app.get("/boom", () => {
    throw err;
  });
  app.post("/echo", (req, res) => {
    res.json(req.body);
  });
  app.use(errorHandler);
  return app;
}

function prismaError(code: string, message = "Prisma failure with secret details") {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "x" });
}

let consoleError: MockInstance;
beforeEach(() => {
  // The 500 branch logs the error; keep test output clean.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe("errorHandler: Prisma transaction timeout (P2028)", () => {
  it("responds 503 with Retry-After: 1 and a retry message", async () => {
    const app = appThrowing(prismaError("P2028", "Transaction already closed"));
    const res = await request(app).get("/boom");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.body).toEqual({ error: "El servidor está ocupado; intenta de nuevo en un momento" });
  });

  it("does not log a P2028 as an internal error", async () => {
    await request(appThrowing(prismaError("P2028"))).get("/boom");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("errorHandler: other errors", () => {
  it("another Prisma error (P2002 unique) stays 500 without leaking details nor Retry-After", async () => {
    const res = await request(appThrowing(prismaError("P2002", "Unique constraint failed on users_email_key"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Error interno del servidor" });
    expect(JSON.stringify(res.body)).not.toMatch(/P2002|users_email_key|secret/);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("a plain Error is a 500 without details", async () => {
    const res = await request(appThrowing(new Error("db password is hunter2"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Error interno del servidor" });
  });

  it("an object that only looks like P2028 (not a Prisma error) is a 500", async () => {
    const res = await request(appThrowing({ code: "P2028", message: "fake" })).get("/boom");
    expect(res.status).toBe(500);
  });

  it("an AppError keeps its status and message", async () => {
    const res = await request(appThrowing(new ConflictError("Choque"))).get("/boom");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Choque" });
  });

  it("an AppError with a code responds { error, code }", async () => {
    const err = new ConflictError("Choque");
    err.code = "OVERLAP";
    const res = await request(appThrowing(err)).get("/boom");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Choque", code: "OVERLAP" });
  });

  it("an AppError without a code responds only { error } (no code key at all)", async () => {
    const res = await request(appThrowing(new ConflictError("Choque"))).get("/boom");
    expect(Object.keys(res.body)).toEqual(["error"]);
  });

  it("an AppError with an empty-string code responds only { error }", async () => {
    const err = new ConflictError("Choque");
    err.code = "";
    const res = await request(appThrowing(err)).get("/boom");
    expect(res.body).toEqual({ error: "Choque" });
  });

  it("a plain Error with a code property is still a 500 that does not leak the code", async () => {
    const res = await request(appThrowing(Object.assign(new Error("x"), { code: "OVERLAP" }))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Error interno del servidor" });
  });

  it("a ZodError is a 400 with details", async () => {
    const parsed = z.object({ a: z.string({ error: "a es obligatorio" }) }).safeParse({});
    const res = await request(appThrowing(parsed.error)).get("/boom");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Datos de entrada inválidos", details: ["a es obligatorio"] });
  });

  it("malformed JSON is a 400 with the JSON message", async () => {
    const res = await request(appThrowing(null))
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"a": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El cuerpo de la petición no es JSON válido" });
  });
});

describe("isTransactionTimeout", () => {
  it("true for a PrismaClientKnownRequestError with code P2028", () => {
    expect(isTransactionTimeout(prismaError("P2028"))).toBe(true);
  });

  it.each(["P2002", "P2025", "P2034", "P1001", "p2028", ""])("false for a Prisma error with code %j", (code) => {
    expect(isTransactionTimeout(prismaError(code))).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "P2028"],
    ["a plain object with code P2028", { code: "P2028" }],
    ["a plain Error", new Error("P2028")],
    ["an Error with code P2028", Object.assign(new Error("x"), { code: "P2028" })],
    ["a ConflictError", new ConflictError()],
  ])("false for %s", (_label, value) => {
    expect(isTransactionTimeout(value)).toBe(false);
  });
});

describe("errorHandler: logs without secrets", () => {
  const SECRET_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2VjcmV0c2FsdA$secret-hash-value";
  const SECRET_PASSWORD = "mi contraseña super secreta 123";

  /** Everything console.error received, serialized (including nested objects). */
  function logged(): string {
    return consoleError.mock.calls.map((args) => JSON.stringify(args, (_key, value: unknown) => value)).join("\n");
  }

  it("logs a Prisma validation error without its message (which prints the query arguments)", async () => {
    const err = new Prisma.PrismaClientValidationError(
      `Invalid \`prisma.user.update()\` invocation:\n{ data: { passwordHash: "${SECRET_HASH}", password: "${SECRET_PASSWORD}" } }`,
      { clientVersion: "x" },
    );
    const res = await request(appThrowing(err)).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Error interno del servidor" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const output = logged();
    expect(output).toContain("PrismaClientValidationError");
    expect(output).not.toContain(SECRET_HASH);
    expect(output).not.toContain(SECRET_PASSWORD);
    expect(output).not.toContain("passwordHash");
    expect(output).not.toContain("Invalid");
  });

  it("logs name, code and stack frames only: never the message or other properties", async () => {
    const err = Object.assign(new Error(`query failed with password=${SECRET_PASSWORD}`), {
      code: "23505",
      meta: { passwordHash: SECRET_HASH },
      parameters: [SECRET_PASSWORD],
    });
    await request(appThrowing(err)).get("/boom");

    const [label, entry] = consoleError.mock.calls[0] as [string, Record<string, unknown>];
    expect(label).toBe("Unhandled error");
    expect(Object.keys(entry).sort()).toEqual(["code", "name", "stack"]);
    expect(entry.name).toBe("Error");
    expect(entry.code).toBe("23505");
    expect(entry.stack).toMatch(/^\s+at /);
    const output = logged();
    expect(output).not.toContain(SECRET_PASSWORD);
    expect(output).not.toContain(SECRET_HASH);
    expect(output).not.toContain("passwordHash");
  });

  it("logs only the type of a thrown non-Error value", async () => {
    await request(appThrowing({ passwordHash: SECRET_HASH })).get("/boom");
    expect(consoleError.mock.calls[0]).toEqual(["Unhandled error", { name: "object" }]);
  });
});
