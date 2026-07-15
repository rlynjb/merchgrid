import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // Scope to this app's own tests. The pure engine at packages/ has its
    // own vitest config and test script; it must not be picked up here.
    include: ["test/**/*.test.ts"],
    exclude: ["packages/**", "node_modules/**"],
    // Avoid concurrent `prisma migrate deploy` / sqlite writers racing
    // against the same test database file.
    fileParallelism: false,
  },
});
