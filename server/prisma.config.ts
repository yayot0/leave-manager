import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prisma 7 ya no carga .env automáticamente: hay que hacerlo explícitamente
// antes de llamar a env(). La ruta se resuelve desde la ubicación física de
// este archivo (no desde el cwd) para que siempre apunte a la raíz del repo.
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(__dirname, "prisma", "migrations"),
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
