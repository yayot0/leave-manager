import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET debe tener al menos 32 caracteres"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28800),
  // Company timezone used to decide what "today" is (e.g. to reject past start dates).
  APP_TIMEZONE: z
    .string()
    .default("America/Monterrey")
    .refine(isValidTimeZone, "APP_TIMEZONE debe ser una zona horaria IANA válida"),
});

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const env = envSchema.parse(process.env);
