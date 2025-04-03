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
    test: isDevEnvironment // Use test mode in development
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
    return new Response("Authentication error", { status: 500 });
  }
  
  const shopDomain = session.shop.toLowerCase().trim();
  
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
        },
      });
      console.log("[app.settings loader] Created new FREE subscription for shop:", shopDomain);
    } else {
      console.log("[app.settings loader] Found existing subscription. Current plan:", shopSub.plan);
    }
  } catch (err) {
    console.error("[app.settings loader] Database error:", err);
    return json({ error: "Database error" }, { status: 500 });
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
      await prisma.shopSubscription.update({
        where: { shop: shopDomain },
        data: {
          plan: "PAID",
          status: "ACTIVE",
          shopifySubscriptionId: shopifySubscription.id,
          // Update other fields as needed
        },
      });
      shopSub = await prisma.shopSubscription.findUnique({
        where: { shop: shopDomain },
      });
      console.log("[app.settings loader] Updated local subscription record to PAID plan");
    }
  } catch (error) {
    console.error("[app.settings loader] Error querying Shopify subscription:", error);
    // Continue execution, as we can still show the page with local DB data
  }
  
  return json({ shopSub, shopifySubscription });
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
      
      const confirmationUrl = await createRecurringSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
        returnUrl,
      });
      
      return json({ confirmationUrl });
    } catch (err) {
      console.error("[app.settings action] Error creating subscription:", err);
      return json({ error: err.message }, { status: 500 });
    }
  }

  // Cancel an active subscription.
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
      
      // Cancel the subscription via Shopify API.
      const canceledSubscription = await cancelRecurringSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
        subscriptionId: subscription.id,
      });
      
      console.log("[app.settings action] Shopify subscription cancelled:", canceledSubscription);
      
      // Update the local DB record to mark the subscription as cancelled.
      const updatedSubscription = await prisma.shopSubscription.update({
        where: { shop: shopDomain },
        data: {
          plan: "FREE",
          status: "CANCELLED",
          variantsLimit: 100,
          shopifySubscriptionId: null,
        },
      });
      
      console.log("[app.settings action] Cancel subscription updated record:", updatedSubscription);
      return json({ success: true, message: "Subscription successfully cancelled" });
    } catch (err) {
      console.error("[app.settings action] Error cancelling subscription:", err);
      return json({ error: err.message }, { status: 500 });
    }
  }

  // Refresh subscription status
  if (intent === "refresh-subscription") {
    try {
      const shopifySubscription = await queryActiveSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
      });
      
      // Optionally update local DB record if we find an active subscription in Shopify
      if (shopifySubscription && shopifySubscription.status === "ACTIVE") {
        await prisma.shopSubscription.update({
          where: { shop: shopDomain },
          data: {
            plan: "PAID",
            status: "ACTIVE", 
            shopifySubscriptionId: shopifySubscription.id,
          },
        });
        console.log("[app.settings action] Updated local subscription record based on refresh");
      }
      
      return json({ 
        success: true, 
        message: "Subscription status refreshed", 
        shopifySubscription 
      });
    } catch (err) {
      console.error("[app.settings action] Error refreshing subscription:", err);
      return json({ error: err.message }, { status: 500 });
    }
  }

  return json({ error: "Unknown action" }, { status: 400 });
}

export default function AppSettings() {
  const { shopSub, shopifySubscription } = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const host = urlParams.get("host") || "";
  const [customUrl, setCustomUrl] = useState(shopSub.customApiUrl || "");
  const isPaidPlan = shopSub.plan === "PAID";
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [currentShopifySubscription, setCurrentShopifySubscription] = useState(shopifySubscription);
  const fetcher = useFetcher();

  useEffect(() => {
    if (actionData?.confirmationUrl) {
      window.top.location.href = actionData.confirmationUrl;
    }
    
    // Update subscription state if we get new data from the action
    if (actionData?.shopifySubscription) {
      setCurrentShopifySubscription(actionData.shopifySubscription);
    }
  }, [actionData]);

  // Helper function to get subscription status badge
  const getStatusBadge = (status) => {
    switch(status) {
      case "ACTIVE":
        return <Badge status="success">Active</Badge>;
      case "CANCELLED":
        return <Badge status="critical">Cancelled</Badge>;
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
    return date.toLocaleDateString();
  };

  // Handle refresh button click
  const handleRefresh = () => {
    fetcher.submit({ intent: "refresh-subscription" }, { method: "post" });
  };

  return (
    <Page title="Projekt: Stock Control Master Settings">
      <TitleBar title="Settings" />
      {actionData?.error && <Banner status="critical" title="Error">{actionData.error}</Banner>}
      {actionData?.success && <Banner status="success" title="Success">{actionData.message}</Banner>}
      <Layout>
        {/* Card para mostrar el estado de la suscripción de Shopify */}
        <Layout.Section>
          <Card title="Shopify Subscription Status" sectioned>
            {currentShopifySubscription ? (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div>
                    <p style={{ fontSize: '16px', fontWeight: '600' }}>{currentShopifySubscription.name || "N/A"}</p>
                    {getStatusBadge(currentShopifySubscription.status)}
                  </div>
                  {/*<Button onClick={handleRefresh}>Refresh</Button>*/}
                </div>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px' }}>
                  <div>
                    <p><strong>Created:</strong> {formatDate(currentShopifySubscription.createdAt)}</p>
                    <p><strong>Trial Days:</strong> {currentShopifySubscription.trialDays || 0}</p>
                  </div>
                  <div>
                    {/*<p><strong>Test Mode:</strong> {currentShopifySubscription.test ? "Yes" : "No"}</p>*/}
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
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p>No active Shopify subscription found.</p>
                {/*<Button onClick={handleRefresh}>Refresh Status</Button>*/}
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
                <Button submit primary>Start Paid Plan</Button>
              </Form>
            ) : (
              <>
                <Button destructive onClick={() => setShowCancelModal(true)}>
                  Cancel Subscription
                </Button>
                <Modal
                  open={showCancelModal}
                  title="Cancel Subscription"
                  primaryAction={{
                    content: "Confirm Cancellation",
                    destructive: true,
                    onAction: () => {
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
                      <p>Are you sure you want to cancel your subscription? This will revert your plan to FREE.</p>
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
                helpText="Projekt: Stock Control Master will send product updates here in JSON format."
              />
              <br />
              <Button submit>Save</Button>
            </Form>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}