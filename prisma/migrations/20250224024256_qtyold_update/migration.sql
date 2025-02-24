/*
  Warnings:

  - The primary key for the `Stockdb` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `Stockdb` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Stockdb_shop_productVariantId_key";

-- AlterTable
ALTER TABLE "Stockdb" DROP CONSTRAINT "Stockdb_pkey",
DROP COLUMN "id",
ALTER COLUMN "title" DROP NOT NULL,
ALTER COLUMN "productId" DROP NOT NULL,
ALTER COLUMN "productHandle" DROP NOT NULL,
ADD CONSTRAINT "Stockdb_pkey" PRIMARY KEY ("shop", "productVariantId");
