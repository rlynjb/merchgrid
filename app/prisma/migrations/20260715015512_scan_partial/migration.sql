-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Scan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "apiVersion" TEXT NOT NULL,
    "minimumMarginPercentUsed" INTEGER NOT NULL,
    "productsProcessed" INTEGER NOT NULL DEFAULT 0,
    "variantsProcessed" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "unavailableCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "failedAt" DATETIME,
    "failureCode" TEXT,
    "failureMessageSafe" TEXT,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Scan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Scan" ("apiVersion", "completedAt", "createdAt", "criticalCount", "failedAt", "failureCode", "failureMessageSafe", "id", "minimumMarginPercentUsed", "productsProcessed", "shopId", "startedAt", "status", "unavailableCount", "updatedAt", "variantsProcessed", "warningCount") SELECT "apiVersion", "completedAt", "createdAt", "criticalCount", "failedAt", "failureCode", "failureMessageSafe", "id", "minimumMarginPercentUsed", "productsProcessed", "shopId", "startedAt", "status", "unavailableCount", "updatedAt", "variantsProcessed", "warningCount" FROM "Scan";
DROP TABLE "Scan";
ALTER TABLE "new_Scan" RENAME TO "Scan";
CREATE INDEX "Scan_shopId_status_idx" ON "Scan"("shopId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
