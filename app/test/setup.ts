import { execSync } from "node:child_process";
import path from "node:path";
import { beforeEach } from "vitest";

// Point Prisma at a dedicated test database BEFORE any module imports
// @prisma/client, so tests never touch the dev database.
const testDatabaseUrl = "file:./test.sqlite";
process.env.DATABASE_URL = testDatabaseUrl;

const appRoot = path.resolve(__dirname, "..");

execSync("npx prisma migrate deploy", {
  cwd: appRoot,
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  stdio: "inherit",
});

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

const DOMAIN_TABLES = [
  "Finding",
  "ScanArtifact",
  "Scan",
  "ShopSettings",
  "Shop",
];

beforeEach(async () => {
  for (const table of DOMAIN_TABLES) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}";`);
  }
});
