import { defineConfig } from "vitest/config";

/**
 * Two separate projects:
 * - unit: pure tests (*.test.ts), never touch a database.
 * - integration: API tests (*.int.test.ts) against the leave_manager_test
 *   database. Files run one at a time because they share that database.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts"],
          setupFiles: ["src/test/setup-unit.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          globalSetup: ["src/test/global-setup.ts"],
          setupFiles: ["src/test/setup-integration.ts"],
          fileParallelism: false,
          testTimeout: 15_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
