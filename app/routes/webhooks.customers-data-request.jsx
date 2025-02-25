import { json } from "@remix-run/node";
import crypto from "crypto";

/**
 * Verify the HMAC signature to confirm the request comes from Shopify.
 *
 * @param {string} body - The raw request body.
 * @param {string} hmacHeader - The HMAC header sent by Shopify.
 * @param {string} secret - Your Shopify API secret.
 * @returns {boolean} - Returns true if the HMAC is valid.
 */
function verifyHmac(body, hmacHeader, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

/**
 * Handles the Shopify customers/data_request webhook.
 *
 * Even though this app does not use customer data, Shopify requires a compliant endpoint.
 * This minimal implementation simply verifies the HMAC and logs the payload.
 */
export const action = async ({ request }) => {
  const rawBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error("Failed to parse request body", err);
    return new Response("Invalid JSON", { status: 400 });
  }

  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !hmacHeader) {
    console.error("Missing secret or HMAC header");
    return new Response("Unauthorized", { status: 401 });
  }
  if (!verifyHmac(rawBody, hmacHeader, secret)) {
    console.error("Invalid HMAC. Request not authorised.");
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("✅ customers/data_request webhook received:", payload);

  // Since we do not handle customer data, no further action is required.
  return new Response("Data request acknowledged", { status: 200 });
};
