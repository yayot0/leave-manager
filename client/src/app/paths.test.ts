import { describe, expect, it } from "vitest";
import { canAccess } from "@/app/navigation";
import {
  employeeDetailPath,
  employeeFromState,
  employeeListBackPath,
  fromEmployeeListState,
  fromEmployeeState,
} from "@/app/paths";

describe("employeeDetailPath", () => {
  it("escapes the id as a single URL segment (no ../, ? or / can change the route)", () => {
    expect(employeeDetailPath("emp-1")).toBe("/administracion/empleados/emp-1");
    expect(employeeDetailPath("../../aprobaciones")).toBe("/administracion/empleados/..%2F..%2Faprobaciones");
    expect(employeeDetailPath("a b?c#d")).toBe("/administracion/empleados/a%20b%3Fc%23d");
  });
});

describe("fromEmployeeListState / employeeListBackPath", () => {
  it("returns to the plain list without state, with another shape or another origin", () => {
    expect(employeeListBackPath(undefined)).toBe("/administracion/empleados");
    expect(employeeListBackPath(null)).toBe("/administracion/empleados");
    expect(employeeListBackPath("?q=ana")).toBe("/administracion/empleados");
    expect(employeeListBackPath({ from: "approvals", search: "?q=ana" })).toBe("/administracion/empleados");
    expect(employeeListBackPath({ from: "employees", search: 42 })).toBe("/administracion/empleados");
  });

  it("keeps the list filters of the state it was opened with", () => {
    const state = fromEmployeeListState("?q=ana&departmentId=dep-1&role=MANAGER&status=all&page=3");
    expect(employeeListBackPath(state)).toBe(
      "/administracion/empleados?q=ana&departmentId=dep-1&role=MANAGER&status=all&page=3",
    );
  });

  it("drops any key that is not a list filter", () => {
    expect(fromEmployeeListState("?q=ana&redirect=https://evil.example&from=x&page=2")).toEqual({
      from: "employees",
      search: "?q=ana&page=2",
    });
    expect(fromEmployeeListState("?redirect=/aprobaciones")).toEqual({ from: "employees", search: "" });
  });

  it("re-sanitizes a hand-made state: it can never point to another path or origin", () => {
    for (const search of ["//evil.example", "https://evil.example/?q=a", "/../aprobaciones", "?q=a&next=//evil"]) {
      const path = employeeListBackPath({ from: "employees", search });
      expect(path.startsWith("/administracion/empleados")).toBe(true);
      expect(path).not.toContain("evil");
      expect(path).not.toContain("aprobaciones");
    }
  });

  it("re-encodes the values, so a filter cannot add a second parameter or a fragment", () => {
    const path = employeeListBackPath({ from: "employees", search: "?q=a%26role%3DHR%23x" });
    expect(path).toBe("/administracion/empleados?q=a%26role%3DHR%23x");
    expect(new URL(path, "http://localhost").searchParams.get("role")).toBeNull();
  });

  it("drops a filter longer than 100 characters (exactly 100 is kept)", () => {
    const hundred = "a".repeat(100);
    expect(employeeListBackPath({ from: "employees", search: `?q=${hundred}` })).toBe(
      `/administracion/empleados?q=${hundred}`,
    );
    expect(employeeListBackPath({ from: "employees", search: `?q=${hundred}a&page=2` })).toBe(
      "/administracion/empleados?page=2",
    );
  });
});

describe("fromEmployeeState / employeeFromState", () => {
  it("round-trips the employee id", () => {
    expect(employeeFromState(fromEmployeeState("emp-1"))).toBe("emp-1");
  });

  it("ignores any other shape (approvals, empty id, non-string id, primitives)", () => {
    expect(employeeFromState(undefined)).toBeNull();
    expect(employeeFromState(null)).toBeNull();
    expect(employeeFromState("emp-1")).toBeNull();
    expect(employeeFromState({ from: "approvals" })).toBeNull();
    expect(employeeFromState({ from: "employee", employeeId: "" })).toBeNull();
    expect(employeeFromState({ from: "employee", employeeId: 7 })).toBeNull();
    expect(employeeFromState({ from: "employees", employeeId: "emp-1" })).toBeNull();
  });
});

describe("canAccess for the employee pages", () => {
  it("lets only HR open the list and the detail", () => {
    for (const path of ["/administracion/empleados", "/administracion/empleados/emp-1"]) {
      expect(canAccess(path, "HR")).toBe(true);
      expect(canAccess(path, "MANAGER")).toBe(false);
      expect(canAccess(path, "EMPLOYEE")).toBe(false);
    }
  });

  it("normalizes case and the trailing slash like the router", () => {
    expect(canAccess("/Administracion/Empleados/", "HR")).toBe(true);
    expect(canAccess("/administracion/empleados/emp-1/", "HR")).toBe(true);
    expect(canAccess("/ADMINISTRACION/EMPLEADOS", "MANAGER")).toBe(false);
  });

  it("denies deeper paths under an employee (default deny)", () => {
    expect(canAccess("/administracion/empleados/emp-1/editar", "HR")).toBe(false);
    expect(canAccess("/administracion/empleado", "HR")).toBe(false);
  });
});
