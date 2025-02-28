// app/settings-callback.jsx

import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import React from "react";

/**
 * Validate that a shop string is a non-empty value.
 * Note: If you support custom domains, do not restrict to ".myshopify.com".
 */
function isValidShop(shop) {
  return typeof shop === "string" && shop.trim() !== "";
}

/**
 * Validate that a chargeId is a non-empty string.
 */
function isValidChargeId(chargeId) {
  return typeof chargeId === "string" && chargeId.trim() !== "";
}

/**
 * Retrieve the shop session headers from the database using Prisma.
 * This fallback mimics webhook authentication in case the embedded auth fails.
 */
async function getShopSessionHeaders(shopDomain) {
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain },
  });
  if (!session || !session.accessToken) {
    throw new Error(`No session or accessToken found for shop: ${shopDomain}`);
  }
  console.log("[Callback] Retrieved session token from DB:", session.accessToken);
  return {
    adminHeaders: {
      "X-Shopify-Access-Token": session.accessToken,
    },
    adminApiUrl: `https://${shopDomain}/admin/api/2024-10/graphql.json`,
  };
}

export async function loader({ request }) {
  console.log("[app.settings-callback loader] Start");
  console.log("[app.settings-callback loader] Request URL:", request.url);

  // Parse query parameters from the URL.
  const url = new URL(request.url);
  let shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host") || "";
  const chargeId = url.searchParams.get("charge_id") || "";
  console.log("[app.settings-callback loader] Received query params:", { shop, host, chargeId });

  // Validate required parameters.
  if (!shop || !isValidShop(shop)) {
    console.error("[app.settings-callback loader] Invalid or missing shop parameter");
    return new Response("Invalid or missing shop parameter", { status: 400 });
  }
  if (!chargeId || !isValidChargeId(chargeId)) {
    console.error("[app.settings-callback loader] Invalid or missing charge_id parameter");
    return new Response("Invalid or missing charge_id parameter", { status: 400 });
  }

  // Normalize shop value for consistency.
  shop = shop.toLowerCase().trim();
  console.log("[app.settings-callback loader] Normalized shop:", shop);

  let sessionShop = null;
  try {
    // Attempt to authenticate the request using the embedded auth strategy.
    const authResult = await authenticate.admin(request);
    // If we have a valid session, use the shop from the session.
    if (authResult.session && authResult.session.shop) {
      console.log("[app.settings-callback loader] Authenticated session:", authResult.session);
      sessionShop = authResult.session.shop.toLowerCase().trim();
    } else {
      console.warn("[app.settings-callback loader] No valid session found; falling back to DB lookup.");
      await getShopSessionHeaders(shop);
      sessionShop = shop;
    }
  } catch (err) {
    // If the error is a redirect (302), use fallback authentication.
    if (err instanceof Response && err.status === 302) {
      console.warn("[app.settings-callback loader] authenticate.admin threw a redirect response. Using fallback authentication.");
      try {
        await getShopSessionHeaders(shop);
        sessionShop = shop;
      } catch (fallbackError) {
        console.error("[app.settings-callback loader] Fallback authentication error:", fallbackError);
        return new Response("Error during authentication fallback", { status: 500 });
      }
    } else {
      console.error("[app.settings-callback loader] Error during authentication:", err);
      return new Response("Error during authentication", { status: 500 });
    }
  }

  // Ensure that the shop from the session matches the shop from the query parameters.
  if (sessionShop !== shop) {
    console.error("[app.settings-callback loader] Shop mismatch:", { sessionShop, queryShop: shop });
    return new Response("Shop mismatch", { status: 400 });
  }

  console.log("[app.settings-callback loader] Finalizing subscription for shop:", sessionShop);

  try {
    // Update the subscription record in the database, marking the plan as "PAID"
    // and storing the Shopify subscription ID (chargeId) for future cancellations.
    const updatedSubscription = await prisma.shopSubscription.update({
      where: { shop: sessionShop },
      data: {
        plan: "PAID",
        status: "ACTIVE",
        variantsLimit: 999999,
        shopifySubscriptionId: chargeId, // Save the Shopify subscription id.
      },
    });
    console.log("[app.settings-callback loader] Updated subscription record:", updatedSubscription);

    // Set security headers and redirect to the settings page.
    const headers = {
      "Content-Security-Policy": "default-src 'self';",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    };

    console.log("[app.settings-callback loader] Redirecting to /app/settings");
    return redirect("/app/settings", { headers });
  } catch (updateError) {
    console.error("[app.settings-callback loader] Error updating subscription:", updateError);
    return new Response("Error updating subscription", { status: 500 });
  }
}

export default function SettingsCallback() {
  return <div>Finalizing your subscription. Please wait...</div>;
}
