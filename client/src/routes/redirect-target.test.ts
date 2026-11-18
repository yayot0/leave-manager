import { describe, expect, it } from "vitest";
import { redirectTarget } from "./redirect-target";
import { canAccess } from "@/app/navigation";

describe("redirectTarget", () => {
  it("returns the original in-app path, including its query string", () => {
    expect(redirectTarget({ from: "/solicitudes?estado=PENDING" }, "EMPLOYEE")).toBe("/solicitudes?estado=PENDING");
  });

  it("returns a role-restricted path when the role may open it", () => {
    expect(redirectTarget({ from: "/aprobaciones" }, "MANAGER")).toBe("/aprobaciones");
  });

  it("accepts a known section regardless of case or trailing slash", () => {
    expect(redirectTarget({ from: "/Solicitudes/" }, "EMPLOYEE")).toBe("/Solicitudes/");
  });

  it.each([
    ["protocol-relative URL", "//sitio-externo.com"],
    ["protocol-relative URL with backslash", "/\\sitio-externo.com"],
    ["URL hidden with a tab", "/\t/sitio-externo.com"],
    ["URL hidden with a newline", "/\n/sitio-externo.com"],
    ["URL hidden with a newline and backslash", "/\n\\sitio-externo.com"],
    ["absolute URL", "https://sitio-externo.com/login"],
    ["javascript: URL", "javascript:alert(1)"],
    ["the login page itself", "/login"],
    ["the login page with other casing", "/Login/"],
  ])("rejects %s and goes home", (_case, from) => {
    expect(redirectTarget({ from }, "HR")).toBe("/saldo");
  });

  it("goes home when the role cannot open the original path", () => {
    expect(redirectTarget({ from: "/aprobaciones" }, "EMPLOYEE")).toBe("/saldo");
    expect(redirectTarget({ from: "/APROBACIONES/" }, "EMPLOYEE")).toBe("/saldo");
    expect(redirectTarget({ from: "/administracion?tab=festivos" }, "MANAGER")).toBe("/saldo");
  });

  it("goes home for unknown paths (default deny)", () => {
    expect(redirectTarget({ from: "/administracion/festivos" }, "EMPLOYEE")).toBe("/saldo");
    expect(redirectTarget({ from: "/no-existe" }, "HR")).toBe("/saldo");
  });

  it.each([null, undefined, {}, { from: 42 }, "texto"])("goes home when the state is %j", (state) => {
    expect(redirectTarget(state, "EMPLOYEE")).toBe("/saldo");
  });
});

describe("canAccess", () => {
  it("allows each role exactly its sections", () => {
    expect(canAccess("/saldo", "EMPLOYEE")).toBe(true);
    expect(canAccess("/aprobaciones", "EMPLOYEE")).toBe(false);
    expect(canAccess("/aprobaciones", "MANAGER")).toBe(true);
    expect(canAccess("/administracion", "MANAGER")).toBe(false);
    expect(canAccess("/administracion", "HR")).toBe(true);
  });

  it("normalizes case and trailing slashes", () => {
    expect(canAccess("/APROBACIONES/", "EMPLOYEE")).toBe(false);
    expect(canAccess("/Aprobaciones//", "MANAGER")).toBe(true);
  });

  it("denies paths that are not a known section", () => {
    expect(canAccess("/", "HR")).toBe(false);
    expect(canAccess("/administracion/festivos", "HR")).toBe(false);
    expect(canAccess("/no-existe", "HR")).toBe(false);
  });

  it("matches the detail route by pattern, one segment per id", () => {
    expect(canAccess("/solicitudes/abc123", "EMPLOYEE")).toBe(true);
    expect(canAccess("/Solicitudes/abc123/", "MANAGER")).toBe(true);
    expect(canAccess("/solicitudes/nueva", "HR")).toBe(true);
    // ":id" is one segment: deeper paths are still unknown, so denied.
    expect(canAccess("/solicitudes/abc/editar", "HR")).toBe(false);
    expect(canAccess("/aprobaciones/abc", "MANAGER")).toBe(false);
  });
});

describe("redirectTarget with the detail route", () => {
  it("returns to a request detail after login", () => {
    expect(redirectTarget({ from: "/solicitudes/abc123" }, "EMPLOYEE")).toBe("/solicitudes/abc123");
  });
});
