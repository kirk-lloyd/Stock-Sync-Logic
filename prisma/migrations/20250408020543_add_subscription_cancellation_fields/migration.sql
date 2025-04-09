-- AlterTable
ALTER TABLE "ShopSubscription" ADD COLUMN     "cancellationDate" TIMESTAMP(3),
ADD COLUMN     "subscriptionData" TEXT;

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhook_eventId_key" ON "ProcessedWebhook"("eventId");

-- CreateIndex
CREATE INDEX "ProcessedWebhook_shop_topic_idx" ON "ProcessedWebhook"("shop", "topic");

-- CreateIndex
CREATE INDEX "ProcessedWebhook_eventId_idx" ON "ProcessedWebhook"("eventId");
