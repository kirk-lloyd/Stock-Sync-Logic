-- CreateTable
CREATE TABLE "ShopSubscription" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopDomain" TEXT,
    "plan" TEXT,
    "status" TEXT,
    "startDate" TIMESTAMP(3),
    "variantsLimit" INTEGER DEFAULT 0,
    "syncsQuantity" INTEGER DEFAULT 0,
    "customApiUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSubscription_shop_key" ON "ShopSubscription"("shop");
