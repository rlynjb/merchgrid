import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@merchgrid/catalog-core": fileURLToPath(
        new URL("./packages/catalog-core/src/index.ts", import.meta.url),
      ),
      "@merchgrid/catalog-checks": fileURLToPath(
        new URL("./packages/catalog-checks/src/index.ts", import.meta.url),
      ),
    },
  },
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
