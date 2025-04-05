// app/settings-callback.jsx

import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import React from "react";

/**
 * Utility function for making API calls to Shopify's GraphQL API.
 */
async function shopifyApiCall({ shop, accessToken, query, variables = {} }) {
  const url = `https://${shop}/admin/api/2023-10/graphql.json`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    const result = await response.json();
    console.log(`[shopifyApiCall] GraphQL response:`, JSON.stringify(result, null, 2));
    
    if (result.errors) {
      console.error("GraphQL Errors:", result.errors);
      throw new Error("GraphQL query failed: " + result.errors[0].message);
    }
    return result.data;
  } catch (error) {
    console.error("API Call Error:", error.message);
    throw error;
  }
}

/**
 * Query the subscriptions from Shopify using currentAppInstallation.
 */
async function queryActiveSubscription({ shop, accessToken }) {
  const query = `
    query {
      currentAppInstallation {
        activeSubscriptions {
          id
          status
          createdAt
          test
          trialDays
          name
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  price {
                    amount
                    currencyCode
                  }
                  interval
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await shopifyApiCall({ shop, accessToken, query });
    const subscriptions = data?.currentAppInstallation?.activeSubscriptions;
    return subscriptions?.length ? subscriptions[0] : null;
  } catch (error) {
    console.error("[queryActiveSubscription] Error:", error.message);
    throw error;
  }
}

/**
 * Retrieve the shop session headers from the database using Prisma.
 */
async function getShopSessionFromDB(shopDomain) {
  try {
    const session = await prisma.session.findFirst({
      where: { shop: shopDomain },
    });
    
    if (!session || !session.accessToken) {
      throw new Error(`No session or accessToken found for shop: ${shopDomain}`);
    }
    
    console.log("[Callback] Retrieved session token from DB:", session.accessToken);
    return session;
  } catch (error) {
    console.error("[getShopSessionFromDB] Error:", error.message);
    throw error;
  }
}

/**
 * Verify that a subscription is active with the given charge ID
 */
async function verifySubscriptionActive({ shop, accessToken, chargeId }) {
  let retryCount = 0;
  const maxRetries = 3;
  const retryDelay = 2000; // 2 seconds
  
  while (retryCount < maxRetries) {
    try {
      const subscription = await queryActiveSubscription({ shop, accessToken });
      
      if (subscription && subscription.status === "ACTIVE") {
        console.log("[verifySubscriptionActive] Subscription is active:", subscription.id);
        return subscription;
      }
      
      console.log(`[verifySubscriptionActive] Attempt ${retryCount + 1}: Subscription not active yet, retrying...`);
      retryCount++;
      
      if (retryCount < maxRetries) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    } catch (error) {
      console.error(`[verifySubscriptionActive] Attempt ${retryCount + 1} error:`, error.message);
      retryCount++;
      
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        throw error;
      }
    }
  }
  
  console.warn("[verifySubscriptionActive] Failed to confirm active subscription after retries");
  return null;
}

export async function loader({ request }) {
  console.log("[app.settings-callback loader] Start");
  console.log("[app.settings-callback loader] Request URL:", request.url);

  // Parse query parameters from the URL
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop")?.toLowerCase().trim();
  const host = url.searchParams.get("host") || "";
  const chargeId = url.searchParams.get("charge_id") || "";
  
  console.log("[app.settings-callback loader] Received query params:", { shop, host, chargeId });

  // Validate required parameters
  if (!shop) {
    console.error("[app.settings-callback loader] Invalid or missing shop parameter");
    return new Response("Invalid or missing shop parameter", { status: 400 });
  }
  
  if (!chargeId) {
    console.error("[app.settings-callback loader] Invalid or missing charge_id parameter");
    return new Response("Invalid or missing charge_id parameter", { status: 400 });
  }

  let session = null;
  
  // Try multiple authentication approaches
  try {
    // First, try the standard authentication
    try {
      const authResult = await authenticate.admin(request);
      
      if (authResult.session && authResult.session.shop) {
        session = authResult.session;
        console.log("[app.settings-callback loader] Successfully authenticated with session");
      }
    } catch (authError) {
      console.warn("[app.settings-callback loader] Standard authentication failed:", authError.message);
    }
    
    // If standard auth failed, try to get session from DB
    if (!session) {
      try {
        session = await getShopSessionFromDB(shop);
        console.log("[app.settings-callback loader] Successfully retrieved session from DB");
      } catch (dbError) {
        console.error("[app.settings-callback loader] Failed to get session from DB:", dbError.message);
        throw new Error("Failed to authenticate: Could not retrieve valid session");
      }
    }

    // Ensure the authenticated shop matches the callback shop
    if (session.shop.toLowerCase() !== shop) {
      console.error("[app.settings-callback loader] Shop mismatch:", { sessionShop: session.shop, queryShop: shop });
      throw new Error("Shop mismatch between authenticated session and callback parameters");
    }

    console.log("[app.settings-callback loader] Verifying subscription status...");
    
    // Verify subscription with Shopify (with retries)
    const subscription = await verifySubscriptionActive({
      shop,
      accessToken: session.accessToken,
      chargeId
    });
    
    // Update the local subscription record
    try {
      const updatedSubscription = await prisma.shopSubscription.update({
        where: { shop },
        data: {
          plan: "PAID",
          status: "ACTIVE",
          variantsLimit: 999999,
          shopifySubscriptionId: chargeId,
          // Store subscription details for further reference
          subscriptionData: JSON.stringify(subscription)
        },
      });
      
      console.log("[app.settings-callback loader] Updated subscription record:", updatedSubscription);
    } catch (updateError) {
      console.error("[app.settings-callback loader] Error updating subscription record:", updateError);
      // Continue even if DB update fails - we can handle this on the settings page
    }

    // Set security headers and redirect to the settings page
    const redirectUrl = `/app/settings?shop=${shop}&host=${host}`;
    console.log("[app.settings-callback loader] Redirecting to:", redirectUrl);
    
    return redirect(redirectUrl, {
      headers: {
        "Content-Security-Policy": "default-src 'self';",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
      }
    });
  } catch (error) {
    console.error("[app.settings-callback loader] Critical error:", error);
    
    // Instead of failing with 500, redirect to settings with error parameter
    return redirect(`/app/settings?shop=${shop}&host=${host}&error=${encodeURIComponent("Error processing subscription: " + error.message)}`);
  }
}

export default function SettingsCallback() {
  return <div>Finalizing your subscription. Please wait...</div>;
}
