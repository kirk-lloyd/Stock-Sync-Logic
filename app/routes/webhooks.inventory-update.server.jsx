/************************************************************************
 * webhooks.inventory-update.server.jsx
 *
 * This Remix route file is now treated as server-only due to the ".server.jsx"
 * extension. We dynamically import our server helpers to avoid bundling
 * them into the client build, resolving the "Server-only module referenced
 * by client" error.
 ************************************************************************/
import { json } from "@remix-run/node";

// There is NO default export (no React component). 
// Only the server 'action' function.

export const action = async ({ request }) => {
  // Dynamically import all your server-side methods from the helper file:
  const {
    verifyHmac,
    getShopSessionHeaders,
    hasExactKey,
    markExactKey,
    buildExactDedupKey,
    buildPredictedKey,
    hasPredictedUpdate,
    markComboKey,
    hasComboKey,
    addEventToAggregator,
    setInventoryQuantity,
    setQtyOldValueDB,
    setQtyOldValue,
    getMasterChildInfo,
    getInventoryItemIdFromVariantId
    // ... any other functions you need
  } = await import("./webhooks.inventory-update.helpers.server.js");

  console.log("🔔 Inventory Webhook => aggregator + difference-based + childDivisor=1 logic.");

  // 1) Parse raw body
  const rawBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    console.error("Payload parse error:", error);
    return new Response("Bad Request", { status: 400 });
  }
  console.log("Webhook payload:", payload);

  // 2) Verify HMAC
  const secret = process.env.SHOPIFY_API_SECRET;
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
  if (!secret || !hmacHeader) {
    console.error("Missing secret or HMAC => aborting.");
    return new Response("Unauthorised", { status: 401 });
  }
  const isValid = verifyHmac(rawBody, hmacHeader, secret);
  if (!isValid) {
    console.error("Invalid HMAC => not from Shopify => aborting.");
    return new Response("Unauthorised", { status: 401 });
  }
  console.log("✅ HMAC verified successfully.");

  // 3) Retrieve shop domain from header
  const shopDomain = request.headers.get("X-Shopify-Shop-Domain");
  if (!shopDomain) {
    console.error("No X-Shopify-Shop-Domain header => cannot retrieve tokens");
    return new Response("Shop domain missing", { status: 400 });
  }

  // 4) Short-term dedup => 10 seconds
  const dedupKey = buildExactDedupKey(payload);
  if (hasExactKey(dedupKey)) {
    console.log(`Skipping repeated => ${dedupKey}`);
    return new Response("Duplicate skip", { status: 200 });
  }
  markExactKey(dedupKey);

  // 4) Predicted updates => skip
  const pKey = buildPredictedKey(payload.inventory_item_id, payload.location_id, payload.available);
  if (hasPredictedUpdate(pKey)) {
    console.log(`Skipping => predicted future update => ${pKey}`);
    return new Response("Skipped => predicted future update", { status: 200 });
  }

  // 5) 6-second item+location lock
  const shortComboKey = `${payload.inventory_item_id}-${payload.location_id}`;
  if (hasComboKey(shortComboKey)) {
    console.log(`Skipping => combo locked => ${shortComboKey}`);
    return new Response("Skipped => 6s combo lock", { status: 200 });
  }
  markComboKey(shortComboKey);

  // 7) Retrieve admin headers
  let adminHeaders, adminApiUrl;
  try {
    const result = await getShopSessionHeaders(shopDomain);
    adminHeaders = result.adminHeaders;
    adminApiUrl = result.adminApiUrl;
    console.log(`Admin client auth => success for shop: ${shopDomain}`);
  } catch (err) {
    console.error("Auth error =>", err);
    return new Response("Authentication (DB) failed", { status: 403 });
  }

  // 8) Main logic
  const locationId = payload.location_id;
  const inventoryItemId = payload.inventory_item_id;
  const newQty = payload.available;

  // Dynamically import another helper if needed:
  const info = await getMasterChildInfo(shopDomain, adminHeaders, inventoryItemId);

  if (!info) {
    console.log("No MASTER/CHILD relationship found; performing a direct update.");
    await setInventoryQuantity(shopDomain, adminHeaders, inventoryItemId, locationId, newQty);

    // Also store the new qty as oldQty in the DB for future reference
    const { getInventoryItemIdFromVariantId } = await import("./webhooks.inventory-update.helpers.server.js");
    const fallbackVariantId = await fetch(
      `https://${shopDomain}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `
          query getVariantByInventory($inventoryItemId: ID!) {
            inventoryItem(id: $inventoryItemId) {
              variant {
                id
              }
            }
          }`,
          variables: { inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}` },
        }),
      }
    )
      .then((res) => res.json())
      .then((resData) => resData?.data?.inventoryItem?.variant?.id)
      .catch(() => null);

    if (fallbackVariantId) {
      await setQtyOldValueDB(shopDomain, fallbackVariantId, newQty);
      await setQtyOldValue(shopDomain, adminHeaders, fallbackVariantId, newQty);
    } else {
      console.log("Could not determine variantId for direct update, skipping DB 'oldQty' storage.");
    }

    return new Response("No Master/Child => performed a direct update", { status: 200 });
  }

  let variantId;
  let isMaster = false;
  let sku = '';

  if (info.isMaster) {
    isMaster = true;
    variantId = info.variantId;
    sku = info.sku;
  } else {
    isMaster = false;
    variantId = info.childVariantId;
    sku = info.childSku;
  }

  // Import the function to get oldQty from DB
  const { getQtyOldValueDB } = await import("./webhooks.inventory-update.helpers.server.js");
  const oldQty = await getQtyOldValueDB(shopDomain, variantId);
  console.log(`(DB-based oldQty) => old:${oldQty}, new:${newQty}`);

  let comboKey;
  if (info.isMaster) {
    comboKey = `${info.inventoryItemId}-${locationId}`;
  } else {
    comboKey = `${info.masterInventoryItemId}-${locationId}`;
  }

  // Build event object
  const eventObj = {
    shopDomain,
    adminHeaders,
    isMaster,
    locationId,
    newQty,
    oldQty,
    sku
  };

  if (info.isChild) {
    eventObj.masterInventoryItemId = info.masterInventoryItemId;
    eventObj.masterVariantId = info.masterVariantId;
    eventObj.childVariantId = info.childVariantId;
    eventObj.inventoryItemId = info.inventoryItemId;
  } else {
    eventObj.variantId = info.variantId;
    eventObj.inventoryItemId = info.inventoryItemId;
  }

  addEventToAggregator(comboKey, eventObj);
  return new Response("Event queued => waiting for aggregator to finalise", { status: 200 });
};