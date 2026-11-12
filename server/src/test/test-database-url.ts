import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root of the repo, where the shared .env lives. */
export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const SERVER_ROOT = path.resolve(__dirname, "../..");

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/**
 * Reads TEST_DATABASE_URL and refuses to continue unless it clearly points to
 * a test database: its name must end in "_test" and differ from the
 * development database in DATABASE_URL. This is what guarantees integration
 * tests can never wipe the development data.
 */
export function resolveTestDatabaseUrl(): string {
  dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is not set. Add it to the root .env file.");
  }

  const testDb = databaseName(testUrl);
  // Plain lowercase identifier ending in "_test": safe to interpolate into
  // CREATE DATABASE and impossible to confuse with the development database.
  if (!/^[a-z0-9_]+_test$/.test(testDb)) {
    throw new Error(
      `Refusing to run tests: database "${testDb}" must match /^[a-z0-9_]+_test$/.`,
    );
  }

  // DATABASE_URL may already have been overwritten by a previous setup run;
  // compare against the dev URL kept aside the first time.
  const devUrl = process.env.DEV_DATABASE_URL ?? process.env.DATABASE_URL;
  if (devUrl && devUrl !== testUrl && databaseName(devUrl) === testDb) {
    throw new Error("Refusing to run tests: TEST_DATABASE_URL points to the development database.");
  }

  return testUrl;
}

export { databaseName };
