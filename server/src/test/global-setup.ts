import { execFileSync } from "node:child_process";
import pg from "pg";
import { SERVER_ROOT, databaseName, resolveTestDatabaseUrl } from "./test-database-url.js";

/**
 * Runs once before the integration project:
 * 1. Creates the test database if it does not exist yet.
 * 2. Applies every migration to it with `prisma migrate deploy` (the same
 *    command used in production: it only applies pending migrations and never
 *    resets data or generates new migrations).
 */
export default async function globalSetup() {
  const testUrl = resolveTestDatabaseUrl();
  const testDb = databaseName(testUrl);

  // Connect to the maintenance database to be able to CREATE DATABASE.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [testDb]);
    if (!rowCount) {
      // Identifiers cannot be parameterized; testDb was validated against
      // /^[a-z0-9_]+_test$/ in resolveTestDatabaseUrl, so quoting is enough.
      await admin.query(`CREATE DATABASE "${testDb}"`);
    }
  } finally {
    await admin.end();
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: "inherit",
  });
}
