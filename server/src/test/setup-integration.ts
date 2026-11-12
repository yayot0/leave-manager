import { resolveTestDatabaseUrl } from "./test-database-url.js";

/**
 * Runs in every integration test worker BEFORE the test file is imported, so
 * by the time src/db/prisma.ts reads DATABASE_URL it already points to the
 * test database. dotenv never overrides variables that are already set, so
 * the value from .env cannot sneak back in.
 */
const testUrl = resolveTestDatabaseUrl();
process.env.DEV_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = "test";
process.env.APP_TIMEZONE = "America/Monterrey";
