// ./webhooks/inventory-update.jsx
import { json } from "@remix-run/node";
import crypto from "crypto";
import { authenticate } from "../shopify.server"; // Adjust path as needed
import { updateInventoryForVariant } from "./inventory.service.js";

/**
 * Helper function to verify Shopify webhook HMAC signature.
 *
 * @param {string} body - The raw request body.
 * @param {string} hmacHeader - The X-Shopify-Hmac-Sha256 header value.
 * @param {string} secret - The webhook secret.
 * @returns {boolean} - True if the signature is valid; otherwise, false.
 */
function verifyHmac(body, hmacHeader, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");

  console.log("Verifying webhook signature:");
  console.log("Provided header:", hmacHeader);
  console.log("Generated digest:", digest);

  const isValid = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  console.log("HMAC valid:", isValid);
  return isValid;
}

/**
 * Action function to handle the inventory_levels/update webhook payload.
 * It verifies the signature, extracts the inventory_item_id, location_id,
 * and available quantity from the payload, and then updates the inventory
 * using the shared updateInventoryForVariant function.
 */
export const action = async ({ request }) => {
  console.log("Received webhook request for inventory update.");
  
  const secret = process.env.WEBHOOK_SECRET;
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
  const rawBody = await request.text();
  console.log("Webhook raw body:", rawBody);

  if (!verifyHmac(rawBody, hmacHeader, secret)) {
    console.error("Invalid webhook signature.");
    return new Response("Invalid webhook", { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  console.log("Parsed webhook payload:", payload);

  // Authenticate to obtain the Shopify admin client.
  const { admin } = await authenticate.admin(request);
  console.log("Authenticated Shopify admin client for webhook.");

  // Extract necessary fields from the payload.
  const inventoryItemId = payload.inventory_item_id;
  const newQuantity = payload.available;
  const locationId = payload.location_id;
  console.log(`Webhook details - inventoryItemId: ${inventoryItemId}, newQuantity: ${newQuantity}, locationId: ${locationId}`);

  // Query the variant that corresponds to this inventory item.
  const variantQuery = `#graphql
    query getVariantByInventoryItem($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        id
        variant {
          id
          inventoryQuantity
          inventoryItem {
            id
          }
          masterMetafield: metafield(namespace: "projektstocksyncmaster", key: "master") {
            value
          }
          childrenMetafield: metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
            value
          }
        }
      }
    }
  `;
  console.log("Querying variant using inventoryItemId:", inventoryItemId);
  const variantResponse = await admin.graphql(variantQuery, { inventoryItemId });
  const variantData = await variantResponse.json();
  console.log("Variant query response:", variantData);
  
  const variant = variantData?.data?.inventoryItem?.variant;
  if (!variant) {
    console.error("Variant not found for inventoryItemId:", inventoryItemId);
    return new Response("Variant not found", { status: 404 });
  }
  
  const variantId = variant.id;
  console.log(`Found variant ${variantId} for inventoryItemId ${inventoryItemId}`);

  try {
    console.log("Calling updateInventoryForVariant from webhook");
    const result = await updateInventoryForVariant({ admin, variantId, newQuantity, locationId });
    console.log("updateInventoryForVariant result:", result);
    return json(result);
  } catch (error) {
    console.error("Error updating inventory from webhook:", error);
    return json({ error: error.message }, { status: 400 });
  }
};
