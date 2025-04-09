// app/settings.jsx

import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  Form,
  useLocation,
  useFetcher,
} from "@remix-run/react";
import React, { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Prisma } from "@prisma/client";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Banner,
  Modal,
  TextContainer,
  Badge,
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

/**
 * Utility function for making API calls to Shopify's GraphQL API.
 * 
 * @param {Object} params - Parameters for the API call.
 * @param {string} params.shop - The shop domain.
 * @param {string} params.accessToken - The access token for authentication.
 * @param {string} params.query - The GraphQL query or mutation.
 * @param {Object} params.variables - Variables for the GraphQL query (optional).
 * @returns {Object} - The data from the API response.
 * @throws {Error} - If the API call fails.
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
 *
 * @param {Object} params - Contains shop and accessToken.
 * @returns {Object|null} - The active subscription or null if none found.
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
 * Cancel a recurring subscription in Shopify using the GraphQL API.
 *
 * @param {Object} params - Contains shop, accessToken, and subscriptionId.
 * @returns {Object} - The canceled subscription data.
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
    console.error("[cancelRecurringSubscription] Error:", error.message);
    throw error;
  }
}

/**
 * Create a recurring subscription using Shopify's GraphQL API.
 *
 * @param {Object} params - Contains shop, accessToken, and returnUrl.
 * @returns {string} confirmationUrl for the subscription.
 */
async function createRecurringSubscription({ shop, accessToken, returnUrl }) {
  const query = `
    mutation CreateSynclogicSubscription($returnUrl: URL!, $test: Boolean) {
      appSubscriptionCreate(
        name: "Stock Control Master Paid Plan"
        returnUrl: $returnUrl
        test: $test
        trialDays: 7
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: 49.99, currencyCode: USD }
              interval: EVERY_30_DAYS
            }
          }
        }]
      ) {
        userErrors {
          field
          message
        }
        confirmationUrl
        appSubscription {
          id
          status
        }
      }
    }
  `;

  // Determine if we're in a development environment
  const isDevEnvironment = process.env.NODE_ENV === 'development';
  const variables = { 
    returnUrl,
    test: true // Use test mode in development
  };

  try {
    const data = await shopifyApiCall({ shop, accessToken, query, variables });
    const { confirmationUrl, userErrors } = data?.appSubscriptionCreate;

    if (userErrors?.length) {
      throw new Error(userErrors[0].message);
    }

    return confirmationUrl;
  } catch (error) {
    console.error("[createRecurringSubscription] Error:", error.message);
    throw error;
  }
}

/**
 * Calculate the end date of the current subscription period based on start date and interval
 * 
 * @param {string} startDateString - The subscription start date
 * @param {string} interval - The billing interval (e.g., "EVERY_30_DAYS")
 * @returns {Date} - The calculated end date of the current period
 */
function calculatePeriodEndDate(startDateString, interval) {
  const startDate = new Date(startDateString);
  const currentDate = new Date();
  
  // Default to 30 days if we can't determine interval
  let daysInPeriod = 30;
  
  if (interval) {
    // Extract the number from interval string (e.g., "EVERY_30_DAYS" -> 30)
    const matches = interval.match(/EVERY_(\d+)_DAYS/);
    if (matches && matches[1]) {
      daysInPeriod = parseInt(matches[1], 10);
    } else if (interval === "ANNUAL") {
      daysInPeriod = 365;
    } else if (interval === "MONTHLY") {
      daysInPeriod = 30;
    }
  }
  
  // Calculate how many full periods have passed since subscription started
  const daysSinceStart = Math.floor((currentDate - startDate) / (1000 * 60 * 60 * 24));
  const periodsPassed = Math.floor(daysSinceStart / daysInPeriod);
  
  // Calculate the end date of the current period
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + ((periodsPassed + 1) * daysInPeriod));
  
  return endDate;
}

/**
 * Check if there are any subscriptions that were scheduled for cancellation
 * and have reached their end date
 */
async function processPendingCancellations(shopDomain, accessToken) {
  try {
    console.log("[processPendingCancellations] Starting check for shop:", shopDomain);
    console.log("[processPendingCancellations] Current time:", new Date().toISOString());
    
    // Use raw SQL query to find pending cancellations to avoid date comparison issues
    const pendingCancellations = await prisma.$queryRaw`
      SELECT *
      FROM "ShopSubscription"
      WHERE shop = ${shopDomain}
      AND status = 'PENDING_CANCELLATION'
      AND "cancellationDate" <= ${Prisma.raw("CURRENT_TIMESTAMP")}
    `;
    
    // Debug log for the query results
    console.log(`[processPendingCancellations] Found ${pendingCancellations.length} subscriptions due for cancellation`);
    
    if (pendingCancellations.length === 0) {
      // If no pending cancellations were found with the date criteria, let's check if there are any pending ones at all
      const allPending = await prisma.shopSubscription.findMany({
        where: {
          shop: shopDomain,
          status: "PENDING_CANCELLATION",
        },
      });
      
      if (allPending.length > 0) {
        console.log(`[processPendingCancellations] Found ${allPending.length} pending cancellations with future dates:`, 
          JSON.stringify(allPending.map(sub => ({
            shop: sub.shop,
            cancellationDate: sub.cancellationDate,
            currentDate: new Date()
          })), null, 2)
        );
      }
      
      return null;
    }
    
    // Process each pending cancellation
    for (const subscription of pendingCancellations) {
      // Shopify subscription may already be cancelled, but we'll try anyway
      try {
        if (subscription.shopifySubscriptionId) {
          await cancelRecurringSubscription({
            shop: shopDomain,
            accessToken,
            subscriptionId: subscription.shopifySubscriptionId,
          });
        }
        
        // Update our database regardless of Shopify API result
        await prisma.shopSubscription.update({
          where: { shop: shopDomain },
          data: {
            plan: "FREE",
            status: "CANCELLED",
            variantsLimit: 100,
            shopifySubscriptionId: null,
            cancellationDate: null, // Clear the cancellation date
          },
        });
        
        console.log(`[processPendingCancellations] Successfully processed cancellation for shop: ${shopDomain}`);
      } catch (err) {
        console.error(`[processPendingCancellations] Error processing cancellation for shop ${shopDomain}:`, err);
      }
    }
    
    return pendingCancellations[0]; // Return the first one for UI updates
  } catch (err) {
    console.error("[processPendingCancellations] Error:", err);
    return null;
  }
}

export async function loader({ request }) {
  let session;
  try {
    const authResult = await authenticate.admin(request);
    if (authResult instanceof Response) {
      return authResult;
    }
    if (!authResult.session || !authResult.session.shop) {
      const url = new URL(request.url);
      const shop = url.searchParams.get("shop") || "";
      const returnTo = encodeURIComponent(request.url);
      return redirect(`/auth?shop=${shop}&return_to=${returnTo}`);
    }
    session = authResult.session;
  } catch (err) {
    console.error("[app.settings loader] Authentication error:", err);
    // Return basic data to prevent UI errors, but indicate auth failure
    return json({ 
      shopSub: null, 
      shopifySubscription: null, 
      errorMessage: "Authentication error. Please refresh the page." 
    });
  }
  
  const shopDomain = session.shop.toLowerCase().trim();
  
  // Process any pending cancellations that have reached their end date
  await processPendingCancellations(shopDomain, session.accessToken);
  
  // Get URL parameters including potential error messages from callback
  const url = new URL(request.url);
  const errorMessage = url.searchParams.get("error");
  
  // Get or create shop subscription from database
  let shopSub;
  try {
    shopSub = await prisma.shopSubscription.findUnique({
      where: { shop: shopDomain },
    });
    
    if (!shopSub) {
      shopSub = await prisma.shopSubscription.create({
        data: {
          shop: shopDomain,
          shopDomain,
          plan: "FREE",
          status: "ACTIVE",
          startDate: new Date(),
          variantsLimit: 100,
          syncsQuantity: 0,
          shopifySubscriptionId: null,
          customApiUrl: "", // Initialize with empty string to prevent undefined
          cancellationDate: null, // Add cancellation date field
        },
      });
      console.log("[app.settings loader] Created new FREE subscription for shop:", shopDomain);
    } else {
      console.log("[app.settings loader] Found existing subscription. Current plan:", shopSub.plan);
      
      // Ensure customApiUrl isn't undefined
      if (shopSub.customApiUrl === undefined) {
        shopSub.customApiUrl = "";
      }
    }
  } catch (err) {
    console.error("[app.settings loader] Database error:", err);
    // Return a minimal shopSub object to prevent UI errors
    shopSub = { 
      shop: shopDomain,
      plan: "FREE", 
      status: "ACTIVE",
      customApiUrl: "",
    };
    return json({ 
      shopSub, 
      shopifySubscription: null, 
      errorMessage: errorMessage || "Database error. Your settings may not load correctly." 
    });
  }
  
  // Query Shopify API for the current subscription status
  let shopifySubscription = null;
  try {
    shopifySubscription = await queryActiveSubscription({
      shop: shopDomain,
      accessToken: session.accessToken,
    });
    console.log("[app.settings loader] Shopify subscription status:", shopifySubscription?.status);
    
    // Optionally update local DB record if we find an active subscription in Shopify
    // but our local record doesn't match
    if (shopifySubscription && shopifySubscription.status === "ACTIVE" && shopSub.plan !== "PAID") {
      try {
        await prisma.shopSubscription.update({
          where: { shop: shopDomain },
          data: {
            plan: "PAID",
            status: "ACTIVE",
            shopifySubscriptionId: shopifySubscription.id,
            startDate: shopifySubscription.createdAt, // Ensure we have the correct start date
          },
        });
        shopSub = await prisma.shopSubscription.findUnique({
          where: { shop: shopDomain },
        });
        console.log("[app.settings loader] Updated local subscription record to PAID plan");
      } catch (updateErr) {
        console.error("[app.settings loader] Error updating subscription record:", updateErr);
        // Continue with existing shopSub even if update fails
      }
    }
  } catch (error) {
    console.error("[app.settings loader] Error querying Shopify subscription:", error);
    // Continue execution, as we can still show the page with local DB data
  }
  
  // Enhance shopifySubscription with cancellation date from shopSub if needed
  let enhancedShopifySubscription = shopifySubscription;
  if (shopSub?.status === "PENDING_CANCELLATION" && shopSub?.cancellationDate) {
    enhancedShopifySubscription = shopifySubscription ? {
      ...shopifySubscription,
      pendingCancellationDate: shopSub.cancellationDate.toISOString()
    } : {
      // Create a minimal subscription object if none exists
      status: "PENDING_CANCELLATION",
      pendingCancellationDate: shopSub.cancellationDate.toISOString()
    };
  }
  
  return json({ shopSub, shopifySubscription: enhancedShopifySubscription, errorMessage });
}

export async function action({ request }) {
  let session;
  try {
    const authResult = await authenticate.admin(request);
    if (authResult instanceof Response) {
      return authResult;
    }
    if (!authResult.session || !authResult.session.shop) {
      const url = new URL(request.url);
      const shop = url.searchParams.get("shop") || "";
      const returnTo = encodeURIComponent(request.url);
      return redirect(`/auth?shop=${shop}&return_to=${returnTo}`);
    }
    session = authResult.session;
  } catch (err) {
    console.error("[app.settings action] Authentication error:", err);
    return json({ error: "Authentication error" }, { status: 500 });
  }
  
  const shopDomain = session.shop.toLowerCase().trim();
  const formData = await request.formData();
  const intent = formData.get("intent");
  console.log("[app.settings action] Received intent:", intent);

  // Save custom API URL settings.
  if (intent === "save-settings") {
    try {
      const customApiUrl = formData.get("customApiUrl")?.toString() || "";
      await prisma.shopSubscription.update({
        where: { shop: shopDomain },
        data: { customApiUrl },
      });
      return json({ success: true, message: "Settings saved successfully" });
    } catch (err) {
      console.error("[app.settings action] Error saving settings:", err);
      return json({ error: "Failed to save settings" }, { status: 500 });
    }
  }

  // Start a paid subscription plan.
  if (intent === "start-paid-plan") {
    try {
      const url = new URL(request.url);
      const host = url.searchParams.get("host") || "";
      const appUrl = process.env.SHOPIFY_APP_URL || "https://your-ngrok-domain.ngrok-free.app";
      const returnUrl = `${appUrl}/app/settings-callback?shop=${shopDomain}&host=${host}`;
      
      console.log("[app.settings action] Creating subscription with returnUrl:", returnUrl);
      
      const confirmationUrl = await createRecurringSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
        returnUrl,
      });
      
      console.log("[app.settings action] Received confirmationUrl:", confirmationUrl);
      return json({ confirmationUrl });
    } catch (err) {
      console.error("[app.settings action] Error creating subscription:", err);
      return json({ error: err.message }, { status: 500 });
    }
  }

  // Schedule subscription cancellation at the end of the current billing period
  if (intent === "cancel-subscription") {
    try {
      // Query Shopify for the current subscriptions.
      const subscription = await queryActiveSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
      });
      
      if (!subscription || !subscription.id) {
        throw new Error("No active subscription found in Shopify");
      }
      
      // Get the interval from the subscription
      const interval = subscription.lineItems && 
                       subscription.lineItems[0]?.plan?.pricingDetails?.interval;
      
      // Calculate when the subscription period ends
      const endDate = calculatePeriodEndDate(subscription.createdAt, interval);
      
      console.log("[app.settings action] Subscription scheduled for cancellation on:", endDate.toISOString());
      
      // Update the local DB record to mark the subscription as pending cancellation
      const updatedSubscription = await prisma.shopSubscription.update({
        where: { shop: shopDomain },
        data: {
          status: "PENDING_CANCELLATION",
          cancellationDate: endDate,
        },
      });
      
      console.log("[app.settings action] Updated subscription status to PENDING_CANCELLATION:", updatedSubscription);
      
      return json({ 
        success: true, 
        message: "Subscription scheduled for cancellation at the end of the current billing period", 
        shopifySubscription: {
          ...subscription,
          pendingCancellationDate: endDate.toISOString()
        }
      });
    } catch (err) {
      console.error("[app.settings action] Error cancelling subscription:", err);
      return json({ error: err.message }, { status: 500 });
    }
  }

  // Refresh subscription status
  if (intent === "refresh-subscription") {
    try {
      // Process any pending cancellations that have reached their end date
      await processPendingCancellations(shopDomain, session.accessToken);
      
      const shopifySubscription = await queryActiveSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
      });
      
      console.log("[app.settings action] Refreshed subscription status:", shopifySubscription);
      
      // Get the current shop subscription from DB
      const shopSub = await prisma.shopSubscription.findUnique({
        where: { shop: shopDomain },
      });
      
      // Attach the cancellation date to the response if it exists
      let enhancedSubscription = shopifySubscription;
      if (shopSub && shopSub.status === "PENDING_CANCELLATION" && shopSub.cancellationDate) {
        enhancedSubscription = {
          ...shopifySubscription,
          pendingCancellationDate: shopSub.cancellationDate.toISOString()
        };
      }
      
      // Optionally update local DB record if we find an active subscription in Shopify
      if (shopifySubscription && shopifySubscription.status === "ACTIVE" && 
          (!shopSub || (shopSub.plan !== "PAID" && shopSub.status !== "PENDING_CANCELLATION"))) {
        try {
          await prisma.shopSubscription.update({
            where: { shop: shopDomain },
            data: {
              plan: "PAID",
              status: "ACTIVE", 
              shopifySubscriptionId: shopifySubscription.id,
              startDate: shopifySubscription.createdAt, // Ensure we have the correct start date
            },
          });
          console.log("[app.settings action] Updated local subscription record based on refresh");
        } catch (err) {
          console.error("[app.settings action] Error updating subscription:", err);
          // Continue even if update fails
        }
      }
      
      return json({ 
        success: true, 
        message: "Subscription status refreshed", 
        shopifySubscription: enhancedSubscription 
      });
    } catch (err) {
      console.error("[app.settings action] Error refreshing subscription:", err);
      return json({ error: err.message }, { status: 500 });
    }
  }

  return json({ error: "Unknown action" }, { status: 400 });
}

export default function AppSettings() {
  const { shopSub, shopifySubscription, errorMessage } = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const host = urlParams.get("host") || "";
  
  // Use optional chaining to prevent errors if shopSub is undefined
  const [customUrl, setCustomUrl] = useState(shopSub?.customApiUrl || "");
  
  // Convert isPaidPlan to state variable instead of constant
  const [isPaidPlan, setIsPaidPlan] = useState(shopSub?.plan === "PAID");
  
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [currentShopifySubscription, setCurrentShopifySubscription] = useState(shopifySubscription);
  const [isLoading, setIsLoading] = useState(false);
  const fetcher = useFetcher();

  useEffect(() => {
    if (actionData?.confirmationUrl) {
      window.top.location.href = actionData.confirmationUrl;
    }
    
    // When we get new data from an action, set loading state
    if (actionData?.shopifySubscription !== undefined || actionData?.success) {
      setIsLoading(true);
      
      // Simulate a delay to show the loading state
      const timer = setTimeout(() => {
        if (actionData?.shopifySubscription !== undefined) {
          setCurrentShopifySubscription(actionData.shopifySubscription);
        }
        
        // Use setIsPaidPlan instead of direct assignment
        if (actionData?.success && actionData.message === "Subscription scheduled for cancellation at the end of the current billing period") {
          // Don't set isPaidPlan to false yet, as it's still active until the end date
        } else if (actionData?.success && actionData.message === "Subscription successfully cancelled") {
          setIsPaidPlan(false);
        }
        
        setIsLoading(false);
      }, 3000); // 3 second delay
      
      return () => clearTimeout(timer);
    }
  }, [actionData]);

  // Monitor fetcher state to show loading while data is being fetched
  useEffect(() => {
    if (fetcher.state === "submitting") {
      setIsLoading(true);
    } else if (fetcher.data && fetcher.state === "idle") {
      // After fetcher completes and data is received, wait 3 seconds before updating the UI
      const timer = setTimeout(() => {
        // Handle both cases: when subscription data exists and when it's explicitly null
        if (fetcher.data.shopifySubscription !== undefined) {
          setCurrentShopifySubscription(fetcher.data.shopifySubscription);
        }
        
        // If a cancellation was successful, update the UI accordingly
        if (fetcher.data.success && fetcher.data.message === "Subscription successfully cancelled") {
          setCurrentShopifySubscription(null);
          setIsPaidPlan(false);
        }
        
        setIsLoading(false);
      }, 3000);
      
      return () => clearTimeout(timer);
    }
  }, [fetcher.state, fetcher.data]);

  // Add this helper function to get cancellation date from either source
  const getCancellationDate = () => {
    // First try to get it from the Shopify subscription object
    if (currentShopifySubscription?.pendingCancellationDate) {
      return currentShopifySubscription.pendingCancellationDate;
    } 
    // Otherwise try to get it directly from the shop subscription in the database
    else if (shopSub?.status === "PENDING_CANCELLATION" && shopSub?.cancellationDate) {
      // Convert Date object to ISO string if it's not already
      return typeof shopSub.cancellationDate === 'string' 
        ? shopSub.cancellationDate 
        : shopSub.cancellationDate.toISOString();
    }
    return null;
  };

  // Modify the hasPendingCancellation variable to check both sources
  const hasPendingCancellation = shopSub?.status === "PENDING_CANCELLATION" || 
                                currentShopifySubscription?.pendingCancellationDate !== undefined;

  // Helper function to get subscription status badge
  const getStatusBadge = (status, pendingCancellation = false) => {
    if (pendingCancellation) {
      return <Badge status="warning">Cancellation Scheduled</Badge>;
    }
    
    switch(status) {
      case "ACTIVE":
        return <Badge status="success">Active</Badge>;
      case "CANCELLED":
        return <Badge status="critical">Cancelled</Badge>;
      case "PENDING_CANCELLATION":
        return <Badge status="warning">Cancellation Scheduled</Badge>;
      case "EXPIRED":
        return <Badge status="warning">Expired</Badge>;
      case "FROZEN":
        return <Badge status="info">Frozen</Badge>;
      case "PENDING":
        return <Badge status="attention">Pending</Badge>;
      default:
        return <Badge>Unknown</Badge>;
    }
  };

  // Format creation date
  const formatDate = (dateString) => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleDateString('en-AU', { 
      day: 'numeric', 
      month: 'long', 
      year: 'numeric'
    });
  };

  // Handle refresh button click
  const handleRefresh = () => {
    setIsLoading(true);
    fetcher.submit({ intent: "refresh-subscription" }, { method: "post" });
  };

  // Render the loading state for the subscription status card
  const renderLoadingState = () => (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '32px', flexDirection: 'column' }}>
      <Spinner accessibilityLabel="Loading subscription status" size="large" color="teal" />
      <p style={{ marginTop: '16px', color: '#637381' }}>Updating subscription status...</p>
    </div>
  );

  // If shopSub is missing, render a simplified version of the page
  if (!shopSub) {
    return (
      <Page title="Stock Control Master Settings">
        <TitleBar title="Settings" />
        <Banner status="critical" title="Error Loading Settings">
          Unable to load settings. Please refresh the page or contact support.
        </Banner>
      </Page>
    );
  }

  return (
    <Page title="Stock Control Master Settings">
      <TitleBar title="Settings" />
      
      {/* Display error message from callback if present */}
      {errorMessage && (
        <Banner status="critical" title="Subscription Error">
          {errorMessage}
          <div style={{ marginTop: '8px' }}>
            <Button onClick={handleRefresh}>Retry Subscription Verification</Button>
          </div>
        </Banner>
      )}
      
      {actionData?.error && <Banner status="critical" title="Error">{actionData.error}</Banner>}
      {actionData?.success && <Banner status="success" title="Success">{actionData.message}</Banner>}
      
      <Layout>
        {/* Card to display the Shopify subscription status */}
        <Layout.Section>
          <Card title="Shopify Subscription Status" sectioned>
            {isLoading ? (
              renderLoadingState()
            ) : currentShopifySubscription ? (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div>
                    <p style={{ fontSize: '16px', fontWeight: '600' }}>{currentShopifySubscription.name || "N/A"}</p>
                    {getStatusBadge(currentShopifySubscription.status, hasPendingCancellation)}
                  </div>
                  <Button onClick={handleRefresh}>Refresh Status</Button>
                </div>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px' }}>
                  <div>
                    <p><strong>Created:</strong> {formatDate(currentShopifySubscription.createdAt)}</p>
                    <p><strong>Trial Days:</strong> {currentShopifySubscription.trialDays || 0}</p>
                  </div>
                  <div>
                    {currentShopifySubscription.lineItems && currentShopifySubscription.lineItems[0]?.plan?.pricingDetails && (
                      <p>
                        <strong>Price:</strong> {
                          currentShopifySubscription.lineItems[0].plan.pricingDetails.price?.amount || "N/A"
                        } {
                          currentShopifySubscription.lineItems[0].plan.pricingDetails.price?.currencyCode || ""
                        }
                      </p>
                    )}
                  </div>
                </div>
                
                {currentShopifySubscription.lineItems && currentShopifySubscription.lineItems[0]?.plan?.pricingDetails && (
                  <p style={{ marginTop: '12px' }}>
                    <strong>Billing Interval:</strong> {
                      currentShopifySubscription.lineItems[0].plan.pricingDetails.interval?.replace(/_/g, ' ').toLowerCase() || "N/A"
                    }
                  </p>
                )}
                
                {/* Show cancellation info if applicable */}
                {hasPendingCancellation && (
                  <div style={{ marginTop: '16px', padding: '12px', backgroundColor: '#FFF4E5', borderRadius: '4px' }}>
                    <p><strong>Cancellation Scheduled:</strong> Your subscription will be cancelled on {formatDate(getCancellationDate())}</p>
                    <p style={{ fontSize: '14px', marginTop: '4px' }}>You will continue to have full access until this date.</p>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p>No active Shopify subscription found.</p>
                <Button onClick={handleRefresh}>Refresh Status</Button>
              </div>
            )}
          </Card>
        </Layout.Section>
        
        <Layout.Section oneHalf>
          <Card sectioned title="Free Plan">
            <p>
              Limited to 100 variants, includes a 7-day trial. {shopSub.plan === "FREE" && 
                <Badge status="success">Current Plan</Badge>
              }
            </p>
            <p style={{ fontWeight: 500 }}>Price: $0/month</p>
          </Card>
        </Layout.Section>
        <Layout.Section oneHalf>
          <Card sectioned title="Paid Plan">
            <p>
              Unlimited variants, includes a 7-day trial. {isPaidPlan && 
                <Badge status="success">Current Plan</Badge>
              }
            </p>
            <p style={{ fontWeight: 500 }}>Price: $49.99/month</p>
            {!isPaidPlan ? (
              <Form method="post" action={`?host=${host}`}>
                <input type="hidden" name="intent" value="start-paid-plan" />
                <Button submit primary disabled={isLoading}>Start Paid Plan</Button>
              </Form>
            ) : (
              <>
                <Button 
                  destructive 
                  onClick={() => setShowCancelModal(true)} 
                  disabled={isLoading || hasPendingCancellation}
                >
                  {hasPendingCancellation ? "Cancellation Scheduled" : "Cancel Subscription"}
                </Button>
                {hasPendingCancellation && (
                  <p style={{ fontSize: '14px', marginTop: '8px', color: '#637381' }}>
                    Your subscription will remain active until the end of the current billing period.
                  </p>
                )}
                <Modal
                  open={showCancelModal}
                  title="Cancel Subscription"
                  primaryAction={{
                    content: "Confirm Cancellation",
                    destructive: true,
                    onAction: () => {
                      setIsLoading(true);
                      fetcher.submit({ intent: "cancel-subscription", host }, { method: "post" });
                      setShowCancelModal(false);
                    },
                  }}
                  secondaryActions={[
                    {
                      content: "No, Keep Subscription",
                      onAction: () => setShowCancelModal(false),
                    },
                  ]}
                  onClose={() => setShowCancelModal(false)}
                >
                  <Modal.Section>
                    <TextContainer>
                      <p>Are you sure you want to cancel your subscription?</p>
                      <p>Your subscription will remain active until the end of the current billing period, then automatically revert to the FREE plan.</p>
                    </TextContainer>
                  </Modal.Section>
                </Modal>
              </>
            )}
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card sectioned title="Custom API URL">
            <Form method="post">
              <input type="hidden" name="intent" value="save-settings" />
              <TextField
                label="Webhook POST URL"
                name="customApiUrl"
                value={customUrl}
                onChange={setCustomUrl}
                helpText="Stock Control Master will send product updates here in JSON format."
              />
              <br />
              <Button submit disabled={isLoading}>Save</Button>
            </Form>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}