import { randomInt } from "node:crypto";
import { checkPasswordPolicy } from "./password-policy.js";

/**
 * Lowercase letters and digits without the look-alikes 0/o, 1/l (and no
 * uppercase, so no I): easy to read aloud or copy by hand. 32 symbols = 5 bits each.
 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LENGTH = 5;

/**
 * A random temporary password like "k7mqa-x3dpe-9hwtf-rn2cz": 20 symbols
 * from a CSPRNG (crypto.randomInt, never Math.random) ≈ 100 bits of
 * entropy, 23 characters with the dashes, so it meets the password policy.
 *
 * Used by HR password resets and, in RH-B2, when creating an employee. The
 * caller stores only its hash, shows it once and marks it temporary
 * (mustChangePassword), so the employee must replace it on first login.
 */
export function generateTemporaryPassword(): string {
  for (;;) {
    const groups = Array.from({ length: GROUPS }, () =>
      Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
    );
    const password = groups.join("-");
    // Practically always passes; the loop just guarantees it (e.g. a draw
    // with 3 distinct characters would count as trivial).
    if (checkPasswordPolicy(password) === null) return password;
  }
}
