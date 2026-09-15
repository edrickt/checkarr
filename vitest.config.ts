import { defineConfig } from "vitest/config";

// Tests for the plain-Node scripts at the repo root (start/stop/launch, the
// desktop icon). The workspace packages keep their own vitest configs.
export default defineConfig({
  test: {
    include: ["scripts/test/**/*.test.mjs"]
  }
});
