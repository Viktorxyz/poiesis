import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.poiesis/workspaces/**",
      "**/.poiesis/tmp/**",
    ],
  },
});
