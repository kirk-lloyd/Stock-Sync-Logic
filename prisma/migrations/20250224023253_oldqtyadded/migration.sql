/*
  Warnings:

  - A unique constraint covering the columns `[shop,productVariantId]` on the table `Stockdb` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Stockdb" ADD COLUMN     "oldQuantity" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Stockdb_shop_productVariantId_key" ON "Stockdb"("shop", "productVariantId");
