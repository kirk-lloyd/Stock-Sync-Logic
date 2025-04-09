// app/routes/api.check-subscriptions.jsx

import { json } from "@remix-run/node";
import prisma from "../db.server";

/**
 * Utility for making calls to the Shopify GraphQL API.
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
    
    if (result.errors) {
      console.error("[API] GraphQL Errors:", result.errors);
      throw new Error("GraphQL query failed: " + result.errors[0].message);
    }
    return result.data;
  } catch (error) {
    console.error("[API] API Call Error:", error.message);
    throw error;
  }
}

/**
 * Cancel a recurring subscription in Shopify using the GraphQL API.
 */
async function cancelRecurringSubscription({ shop, accessToken, subscriptionId }) {
  const query = `
    mutation CancelAppSubscription($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id: subscriptionId.startsWith("gid://shopify/AppSubscription/")
      ? subscriptionId
      : `gid://shopify/AppSubscription/${subscriptionId}`,
  };

  try {
    const data = await shopifyApiCall({ shop, accessToken, query, variables });
    const { appSubscription, userErrors } = data?.appSubscriptionCancel;

    if (userErrors?.length) {
      throw new Error(userErrors[0].message);
    }

    return appSubscription;
  } catch (error) {
    console.error("[API] Error canceling subscription:", error.message);
    throw error;
  }
}

/**
 * Verify and process all pending cancellations in the system
 */
async function processPendingCancellations() {
  console.log("[API] Starting verification of pending subscription cancellations");
  
  const results = {
    processed: 0,
    failed: 0,
    details: []
  };
  
  try {
    // Find all subscriptions marked for cancellation that have reached their deadline
    const pendingCancellations = await prisma.shopSubscription.findMany({
      where: {
        status: "PENDING_CANCELLATION",
        cancellationDate: {
          lte: new Date(), // The cancellation date is now or in the past
        },
      },
    });
    
    console.log(`[API] Found ${pendingCancellations.length} pending subscription cancellations`);
    
    if (pendingCancellations.length === 0) {
      return results;
    }
    
    // Process each pending cancellation
    for (const subscription of pendingCancellations) {
      const shopResult = {
        shop: subscription.shop,
        status: "pending",
        messages: []
      };
      
      results.details.push(shopResult);
      
      try {
        // Get the access token from the database
        const session = await prisma.session.findFirst({
          where: { shop: subscription.shop },
        });
        
        if (!session || !session.accessToken) {
          shopResult.status = "error";
          shopResult.messages.push("No access token found for the store");
          results.failed++;
          console.error(`[API] No access token found for the store: ${subscription.shop}`);
          continue; // Move to the next subscription
        }
        
        // Try to cancel the subscription in Shopify
        if (subscription.shopifySubscriptionId) {
          try {
            console.log(`[API] Canceling Shopify subscription ID: ${subscription.shopifySubscriptionId}`);
            
            await cancelRecurringSubscription({
              shop: subscription.shop,
              accessToken: session.accessToken,
              subscriptionId: subscription.shopifySubscriptionId,
            });
            
            shopResult.messages.push("Subscription successfully canceled in Shopify");
            console.log(`[API] Shopify subscription successfully canceled`);
          } catch (shopifyError) {
            shopResult.messages.push(`Error canceling in Shopify: ${shopifyError.message}`);
            console.error(`[API] Error canceling subscription in Shopify: ${shopifyError.message}`);
            // We continue anyway to update our database
          }
        }
        
        // Update our database regardless of the Shopify result
        await prisma.shopSubscription.update({
          where: { shop: subscription.shop },
          data: {
            plan: "FREE",
            status: "CANCELLED",
            variantsLimit: 100,
            shopifySubscriptionId: null,
            cancellationDate: null, // Clear the cancellation date
          },
        });
        
        shopResult.status = "success";
        shopResult.messages.push("Subscription status updated to CANCELLED");
        results.processed++;
        console.log(`[API] Subscription record updated to CANCELLED for store: ${subscription.shop}`);
      } catch (err) {
        shopResult.status = "error";
        shopResult.messages.push(`Error: ${err.message}`);
        results.failed++;
        console.error(`[API] Error processing cancellation for store ${subscription.shop}: ${err.message}`);
      }
    }
    
    console.log(`[API] Subscription verification process completed. Processed: ${results.processed}, Failed: ${results.failed}`);
    return results;
  } catch (err) {
    console.error(`[API] General process error: ${err.message}`);
    throw err;
  }
}

// Define a secret API key to protect this endpoint
const API_SECRET = process.env.API_SECRET || "default-secret-key-change-me";

export async function action({ request }) {
  // Validate that the request is via POST
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  
  // Validate authentication via the API key
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_SECRET) {
    return json({ error: "Invalid API key" }, { status: 403 });
  }
  
  try {
    // Process pending subscription cancellations
    const results = await processPendingCancellations();
    
    return json({ 
      success: true, 
      message: `Processed ${results.processed} subscriptions, failed ${results.failed}`,
      timestamp: new Date().toISOString(),
      details: results.details
    });
  } catch (error) {
    console.error("[API] Error processing cancellations:", error);
    return json({ 
      error: "Error processing cancellations", 
      message: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}

// We also support GET for verification (but without processing cancellations)
export async function loader({ request }) {
  // Validate authentication via the API key
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_SECRET) {
    return json({ error: "Invalid API key" }, { status: 403 });
  }
  
  try {
    // Only get the number of pending subscription cancellations
    const pendingCount = await prisma.shopSubscription.count({
      where: {
        status: "PENDING_CANCELLATION",
        cancellationDate: {
          lte: new Date(),
        },
      },
    });
    
    return json({ 
      success: true,
      message: `Found ${pendingCount} pending subscription cancellations`,
      pendingCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("[API] Error verifying subscriptions:", error);
    return json({ 
      error: "Error verifying subscriptions", 
      message: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}