import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@merchgrid/catalog-core": fileURLToPath(
        new URL("./catalog-core/src/index.ts", import.meta.url),
      ),
      "@merchgrid/catalog-checks": fileURLToPath(
        new URL("./catalog-checks/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["**/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
