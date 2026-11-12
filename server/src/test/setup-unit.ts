/**
 * Runs before every unit test file. Unit tests must never touch a database,
 * so DATABASE_URL is blanked out: if a unit test imports src/db/prisma.ts by
 * mistake, it fails immediately instead of connecting to the development DB.
 *
 * It is set to "" rather than deleted on purpose: dotenv (loaded by
 * src/config/env.ts) never overwrites a variable that already exists, even
 * if empty, but it WOULD refill a deleted one from .env.
 */
process.env.DATABASE_URL = "";
