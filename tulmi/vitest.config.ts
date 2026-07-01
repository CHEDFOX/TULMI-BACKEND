import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["tests/**/*.test.ts"],
    // Each test loads the config module which reads env — start from a clean
    // slate so one test's overrides can't leak into another's.
    isolate: true,
    reporters: ["default"],
    // Explicit cache dir so container test runs don't scribble on host mounts.
    cache: false,
  },
});
