import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTemporaryPassword } from "./temporary-password.js";
import { checkPasswordPolicy } from "./password-policy.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

/** 4 groups of 5, from the alphabet without l, o, 0 and 1. */
const FORMAT = /^[a-km-np-z2-9]{5}(-[a-km-np-z2-9]{5}){3}$/;

afterEach(() => {
  vi.mocked(crypto.randomInt).mockClear();
});

describe("generateTemporaryPassword", () => {
  it("has the format xxxxx-xxxxx-xxxxx-xxxxx (23 characters)", () => {
    const password = generateTemporaryPassword();
    expect(password).toMatch(FORMAT);
    expect(password).toHaveLength(23);
  });

  it("never uses the look-alikes l, o, 0, 1 or uppercase (500 draws)", () => {
    for (let i = 0; i < 500; i++) {
      const password = generateTemporaryPassword();
      expect(password).toMatch(FORMAT);
      expect(password).not.toMatch(/[lo01A-Z]/);
    }
  });

  it("always passes checkPasswordPolicy", () => {
    for (let i = 0; i < 500; i++) {
      expect(checkPasswordPolicy(generateTemporaryPassword())).toBeNull();
    }
  });

  it("does not repeat in 2000 generations", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(2000);
  });

  it("uses crypto.randomInt (CSPRNG), one draw per symbol", () => {
    generateTemporaryPassword();
    expect(vi.mocked(crypto.randomInt).mock.calls.length).toBe(20);
  });

  it("draws again when the result would be trivial (e.g. 'aaaaa-aaaaa-aaaaa-aaaaa')", () => {
    const randomInt = vi.mocked(crypto.randomInt) as unknown as { mockReturnValueOnce(v: number): unknown };
    for (let i = 0; i < 20; i++) randomInt.mockReturnValueOnce(0);

    const password = generateTemporaryPassword();

    expect(password).not.toBe("aaaaa-aaaaa-aaaaa-aaaaa");
    expect(password).toMatch(FORMAT);
    expect(checkPasswordPolicy(password)).toBeNull();
    expect(vi.mocked(crypto.randomInt).mock.calls.length).toBe(40);
  });
});
