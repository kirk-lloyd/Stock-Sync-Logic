/*
  Warnings:

  - You are about to drop the column `locationId` on the `WebhookEvent` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "WebhookEvent_inventoryItemId_locationId_idx";

-- AlterTable
ALTER TABLE "WebhookEvent" DROP COLUMN "locationId";

-- CreateIndex
CREATE INDEX "WebhookEvent_inventoryItemId_idx" ON "WebhookEvent"("inventoryItemId");
