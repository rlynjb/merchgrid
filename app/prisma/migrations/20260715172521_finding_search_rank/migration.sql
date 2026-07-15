/*
  Warnings:

  - Added the required column `severityRank` to the `Finding` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "severityRank" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "adminUrl" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "detectedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" TEXT,
    "compareAtPrice" TEXT,
    "unitCost" TEXT,
    "currencyCode" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "productStatus" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "Finding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Backfill severityRank/searchText for pre-existing rows so the new NOT NULL
-- column can be populated without data loss: severityRank mirrors the
-- CRITICAL=0/WARNING=1/UNAVAILABLE=2 mapping in
-- app/services/scan/severity.ts, and searchText mirrors buildSearchText's
-- lowercased, space-joined, null-skipping concatenation of
-- productTitle/variantTitle/sku/barcode.
INSERT INTO "new_Finding" ("adminUrl", "barcode", "checkId", "compareAtPrice", "createdAt", "currencyCode", "detectedAt", "evidenceJson", "explanation", "id", "price", "productId", "productStatus", "productTitle", "scanId", "severity", "severityRank", "shopId", "sku", "unitCost", "variantId", "variantTitle", "searchText")
SELECT
  "adminUrl", "barcode", "checkId", "compareAtPrice", "createdAt", "currencyCode", "detectedAt", "evidenceJson", "explanation", "id", "price", "productId", "productStatus", "productTitle", "scanId", "severity",
  CASE "severity" WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'UNAVAILABLE' THEN 2 ELSE 2 END,
  "shopId", "sku", "unitCost", "variantId", "variantTitle",
  LOWER(
    TRIM(
      "productTitle" ||
      COALESCE(' ' || NULLIF("variantTitle", ''), '') ||
      COALESCE(' ' || NULLIF("sku", ''), '') ||
      COALESCE(' ' || NULLIF("barcode", ''), '')
    )
  )
FROM "Finding";
DROP TABLE "Finding";
ALTER TABLE "new_Finding" RENAME TO "Finding";
CREATE INDEX "Finding_scanId_severity_idx" ON "Finding"("scanId", "severity");
CREATE INDEX "Finding_scanId_severityRank_checkId_idx" ON "Finding"("scanId", "severityRank", "checkId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
