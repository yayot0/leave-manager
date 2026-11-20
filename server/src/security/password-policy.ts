import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePassword } from "./password.js";

/**
 * Password policy based on NIST SP 800-63B rev. 4 (2025):
 * - At least 15 characters, because the password is the only factor (no 2FA).
 *   Length is what makes guessing expensive.
 * - No composition rules (uppercase, symbols…) and no periodic expiration:
 *   they push people to predictable patterns like "Verano2026!".
 * - Any character is allowed, spaces and Unicode included, and pasting from
 *   a password manager works.
 * - Reject what an attacker tries first: breached/common passwords, trivial
 *   patterns, and words taken from the user's own data or the service.
 *
 * Applied when a password is chosen (change-password), never at login.
 */
export const PASSWORD_MIN_LENGTH = 15;
/** Only stops abuse; NIST asks to accept at least 64. */
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordPolicyProblem =
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "PASSWORD_TOO_COMMON"
  | "PASSWORD_CONTAINS_PERSONAL_INFO";

export interface PasswordContext {
  email?: string;
  firstName?: string;
  lastName?: string;
}

export const PASSWORD_POLICY_MESSAGES: Record<PasswordPolicyProblem, string> = {
  PASSWORD_TOO_SHORT: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
  PASSWORD_TOO_LONG: `La contraseña no puede tener más de ${PASSWORD_MAX_LENGTH} caracteres`,
  PASSWORD_TOO_COMMON: "La contraseña es demasiado común o fácil de adivinar",
  PASSWORD_CONTAINS_PERSONAL_INFO: "La contraseña no debe incluir tu nombre, tu correo ni el nombre del sistema",
};

/**
 * Personal words shorter than this are ignored: "de" or "la" from a last
 * name like "De la Cruz" would reject half the Spanish phrases. Short names
 * such as Ana, Eva or Luz (3 letters) still count, as whole words only.
 */
const MIN_PERSONAL_WORD_LENGTH = 3;

/** Words about the service itself, compared as whole words. */
const SERVICE_WORDS = ["leavemanager", "vacaciones"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/data, outside src/, so it resolves the same from src/security and dist/security.
const COMMON_PASSWORDS_FILE = path.resolve(__dirname, "../../data/common-passwords.txt");

/**
 * Loaded once, when the module is imported (about 11k entries): a deploy
 * without server/data fails at startup, not on the first password change.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  readFileSync(COMMON_PASSWORDS_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#")),
);

/** Lowercase without accents: "ÁNA" and "ana" are the same word. */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Words of a text: runs of letters or runs of digits. Spaces, punctuation
 * and the switch between letters and digits separate them, so "ana2026"
 * holds the whole word "ana" (while "banana2026" holds "banana", not "ana").
 */
function wordsOf(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
    .filter((word) => word !== "");
}

/** Code-point length ("ñ" counts as one, as does an emoji). */
function lengthOf(password: string): number {
  return [...password].length;
}

const DIGIT_CYCLE = "0123456789".repeat(16);

/**
 * Trivial patterns no list can cover: too few different characters
 * ("aaaaaaaaaaaaaaa", "abababababababab") or a straight run of consecutive
 * characters, ascending or descending ("abcdefghijklmnop", "123456789012345").
 */
function isTrivial(password: string): boolean {
  const chars = [...password.toLowerCase()];
  if (new Set(chars).size <= 3) return true;

  const codes = chars.map((char) => char.codePointAt(0) ?? 0);
  const step = codes[1] - codes[0];
  if (Math.abs(step) === 1 && codes.every((code, i) => i === 0 || code - codes[i - 1] === step)) {
    return true;
  }

  const reversedCycle = [...DIGIT_CYCLE].reverse().join("");
  return /^\d+$/.test(password) && (DIGIT_CYCLE.includes(password) || reversedCycle.includes(password));
}

function isCommon(password: string): boolean {
  const lower = password.toLowerCase();
  return COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.replace(/\s+/g, ""));
}

/**
 * Personal words are compared as WHOLE words, never as substrings: with the
 * name Ana, "mi banana favorita del mercado" is fine but "ana come tacos" is
 * not. The email's local part is split by ".", "-" and "_" and each part is
 * checked on its own; compound names are split the same way as passwords.
 */
function containsPersonalInfo(password: string, context: PasswordContext): boolean {
  const passwordWords = new Set(wordsOf(password));

  const localPart = context.email?.split("@")[0] ?? "";
  const emailParts = localPart.split(/[._-]+/);
  // Each part on its own ("juan", "perez") and the parts written together
  // ("juanperez"), which is how people paste a username.
  const emailWords = [...emailParts.flatMap(wordsOf), ...wordsOf(emailParts.join(""))];
  const nameWords = [...wordsOf(context.firstName ?? ""), ...wordsOf(context.lastName ?? "")];

  const personalWords = [...emailWords, ...nameWords].filter((word) => word.length >= MIN_PERSONAL_WORD_LENGTH);
  if (personalWords.some((word) => passwordWords.has(word))) return true;

  // The service name is also caught as two consecutive whole words
  // ("leave manager", "Leave-Manager"), but not inside other words
  // ("please leave managerial duties" is fine).
  const words = wordsOf(password);
  const splitServiceName = words.some((word, i) => word === "leave" && words[i + 1] === "manager");
  return SERVICE_WORDS.some((word) => passwordWords.has(word)) || splitServiceName;
}

/**
 * Returns the first problem of a NEW password, or null if it is acceptable.
 * Comparing it against the current one (PASSWORD_UNCHANGED) needs the hash,
 * so the change-password service does that.
 */
export function checkPasswordPolicy(rawPassword: string, context: PasswordContext = {}): PasswordPolicyProblem | null {
  const password = normalizePassword(rawPassword);
  const length = lengthOf(password);

  if (length < PASSWORD_MIN_LENGTH) return "PASSWORD_TOO_SHORT";
  if (length > PASSWORD_MAX_LENGTH) return "PASSWORD_TOO_LONG";
  if (isTrivial(password) || isCommon(password)) return "PASSWORD_TOO_COMMON";
  if (containsPersonalInfo(password, context)) return "PASSWORD_CONTAINS_PERSONAL_INFO";
  return null;
}
