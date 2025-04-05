/************************************************************************
 * webhooks.app_uninstalled.server.jsx
 *
 * This webhook handler processes app uninstallation events, cancels 
 * active Shopify subscriptions, and updates local database records.
 ************************************************************************/
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Cancel a Shopify subscription via GraphQL API
 * @param {string} shop - Shop domain
 * @param {string} accessToken - Shopify access token
 * @param {string} subscriptionId - Subscription ID to cancel
 * @returns {Promise<object|null>} - Canceled subscription or null if failed
 */
async function cancelShopifySubscription(shop, accessToken, subscriptionId) {
  if (!subscriptionId || !accessToken) {
    console.log(`[cancelShopifySubscription] Missing required parameters for shop: ${shop}`);
    return null;
  }

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
    const response = await fetch(
      `https://${shop}/admin/api/2023-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      }
    );

    if (!response.ok) {
      console.error(`[cancelShopifySubscription] HTTP error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    if (data.errors) {
      console.error(`[cancelShopifySubscription] GraphQL errors: ${JSON.stringify(data.errors)}`);
      return null;
    }
    
    const { appSubscription, userErrors } = data?.data?.appSubscriptionCancel || {};

    if (userErrors?.length) {
      console.error(`[cancelShopifySubscription] UserErrors: ${JSON.stringify(userErrors)}`);
      return null;
    }

    return appSubscription;
  } catch (error) {
    console.error(`[cancelShopifySubscription] Error: ${error.message}`);
    return null;
  }
}

/**
 * Process the app uninstallation directly
 * @param {string} shop - Shop domain
 * @param {object} session - Session with accessToken
 */
async function updateShopSubscription(shop) {
  try {
    console.log(`[updateShopSubscription] Direct update for ${shop}`);
    
    // Find the shop's subscription in our database
    const shopSub = await prisma.shopSubscription.findUnique({
      where: { shop },
    });

    if (shopSub) {
      console.log(`[updateShopSubscription] Found subscription for ${shop}. Current status: ${shopSub.status}, plan: ${shopSub.plan}`);

      // Update our database record to mark the subscription as cancelled
      const updatedShopSub = await prisma.shopSubscription.update({
        where: { shop },
        data: {
          status: "CANCELLED",
          plan: "FREE",
          shopifySubscriptionId: null,
        },
      });
      
      console.log(`[updateShopSubscription] Updated database record: ${JSON.stringify(updatedShopSub)}`);
    } else {
      console.log(`[updateShopSubscription] No subscription found for ${shop}`);
    }
  } catch (error) {
    console.error(`[updateShopSubscription] Error updating DB: ${error.message}`, error);
  }
}

/**
 * Check if webhook has already been processed
 * @param {string} eventId - The event ID from Shopify
 * @returns {Promise<boolean>} - Whether the event has been processed
 */
async function isEventProcessed(eventId) {
  if (!eventId) return false;
  
  try {
    const existingWebhook = await prisma.processedWebhook.findUnique({
      where: { eventId }
    });
    return !!existingWebhook;
  } catch (error) {
    console.error(`[isEventProcessed] Database error: ${error.message}`);
    return false;
  }
}

/**
 * Record webhook as processed to prevent duplicate processing
 * @param {string} eventId - Event ID from Shopify
 * @param {string} shop - Shop domain
 * @param {string} topic - Webhook topic
 */
async function recordProcessedWebhook(eventId, shop, topic) {
  if (!eventId) return;
  
  try {
    await prisma.processedWebhook.create({
      data: {
        eventId,
        shop,
        topic,
        processedAt: new Date()
      }
    });
  } catch (error) {
    console.error(`[recordProcessedWebhook] Error recording webhook: ${error.message}`);
  }
}

/**
 * Process the app uninstallation
 * @param {string} shop - Shop domain
 * @param {object} session - Session with accessToken
 * @param {string} eventId - Event ID for tracking
 */
async function processAppUninstallation(shop, session, eventId) {
  console.log(`[processAppUninstallation] Processing uninstall for ${shop}`);
  const startTime = Date.now();
  
  try {
    // First, update the shop subscription directly to ensure it happens
    await updateShopSubscription(shop);
    
    // Check if this event is already processed
    if (await isEventProcessed(eventId)) {
      console.log(`[processAppUninstallation] Event ${eventId} already processed`);
      return;
    }
    
    // Record this event as processed
    await recordProcessedWebhook(eventId, shop, 'app/uninstalled');
    
    // Find the shop's subscription in our database
    const shopSub = await prisma.shopSubscription.findUnique({
      where: { shop },
    });

    if (shopSub) {
      // If there's an active Shopify subscription ID, try to cancel it
      if (shopSub.shopifySubscriptionId && session?.accessToken) {
        console.log(`[processAppUninstallation] Cancelling Shopify subscription ${shopSub.shopifySubscriptionId}`);
        
        const retries = 3;
        let attempt = 0;
        let success = false;
        
        // Retry logic with exponential backoff
        while (attempt < retries && !success) {
          try {
            const cancelled = await cancelShopifySubscription(
              shop, 
              session.accessToken,
              shopSub.shopifySubscriptionId
            );
            
            if (cancelled) {
              console.log(`[processAppUninstallation] Successfully cancelled subscription`);
              success = true;
            } else {
              console.warn(`[processAppUninstallation] Failed to cancel subscription on attempt ${attempt + 1}`);
              attempt++;
              if (attempt < retries) {
                const delay = Math.pow(2, attempt) * 500;
                console.log(`[processAppUninstallation] Retrying in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
              }
            }
          } catch (error) {
            console.error(`[processAppUninstallation] Error during cancellation: ${error.message}`);
            attempt++;
            if (attempt < retries) {
              const delay = Math.pow(2, attempt) * 500;
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }
      }
    }

    // Delete sessions for this shop
    const { count } = await prisma.session.deleteMany({ 
      where: { shop } 
    });
    console.log(`[processAppUninstallation] Deleted ${count} sessions for ${shop}`);
    
    // Log metrics for monitoring
    const duration = Date.now() - startTime;
    console.log(`[processAppUninstallation] Completed in ${duration}ms for ${shop}`);
    
  } catch (error) {
    console.error(`[processAppUninstallation] Unhandled error: ${error.message}`, {
      shop,
      errorType: error.name,
      stack: error.stack
    });
  }
}

/**
 * Main webhook handler action
 */
export async function action({ request }) {
  const startTime = Date.now();
  
  try {
    // Let Shopify's built-in authenticate.webhook handle the HMAC verification
    // This uses the SHOPIFY_API_SECRET from your environment
    const { shop, session, topic } = await authenticate.webhook(request);
    
    const eventId = request.headers.get("X-Shopify-Event-Id");
    console.log(`[APP_UNINSTALLED] Authenticated webhook: shop=${shop}, topic=${topic}, eventId=${eventId}`);
    
    // Update shop subscription immediately
    await updateShopSubscription(shop);
    
    // Process remaining tasks asynchronously after returning 200 OK
    setTimeout(() => {
      processAppUninstallation(shop, session, eventId)
        .catch(error => {
          console.error(`[APP_UNINSTALLED] Async processing error: ${error.message}`);
        });
    }, 0);
    
    const responseTime = Date.now() - startTime;
    console.log(`[APP_UNINSTALLED] Webhook acknowledged in ${responseTime}ms`);
    
    // Return success immediately (optimize response time)
    return new Response("OK", { 
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "X-Webhook-Processing-Time-Ms": responseTime.toString()
      }
    });
    
  } catch (error) {
    console.error(`[APP_UNINSTALLED] Error processing webhook: ${error.message}`);
    
    // Always return 200 to prevent Shopify from retrying
    return new Response("OK - Error Logged", { 
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
}