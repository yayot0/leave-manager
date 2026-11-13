import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // The browser only talks to the Vite dev server (one origin). Vite forwards
    // /api/* to the Express API server-side, so there is no cross-origin request,
    // no CORS preflight, and the httpOnly session cookie is sent as first-party.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
      },
    },
  },
  test: {
    environment: "jsdom",
    environmentOptions: {
      // Gives jsdom a real origin so relative URLs like "/api/auth/me" resolve
      // and MSW can intercept them.
      jsdom: { url: "http://localhost:5173" },
    },
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
