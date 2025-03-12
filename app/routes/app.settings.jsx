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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

/**
 * Query the subscriptions from Shopify using currentAppInstallation.
 * The query retrieves all subscriptions without filtering, so we filter manually.
 *
 * @param {Object} params - Contains shop and accessToken.
 * @returns {Object|null} - The active subscription (id and status) or null if none found.
 */
async function queryActiveSubscription({ shop, accessToken }) {
  const query = `
    query {
      currentAppInstallation {
        subscriptions {
          id
          status
        }
      }
    }
  `;
  const response = await fetch(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    }
  );
  const result = await response.json();
  console.log("[queryActiveSubscription] GraphQL response:", JSON.stringify(result, null, 2));
  const subscriptions = result?.data?.currentAppInstallation?.subscriptions;
  if (subscriptions && subscriptions.length > 0) {
    // Filter for the subscription with status ACTIVE
    const activeSub = subscriptions.find((sub) => sub.status === "ACTIVE");
    return activeSub || null;
  }
  return null;
}

/**
 * Cancel a recurring subscription in Shopify using the GraphQL API.
 * Ensures the subscription ID is in the proper global format.
 *
 * @param {Object} params - Contains shop, accessToken, and subscriptionId.
 * @returns {Object} - The canceled subscription data.
 */
async function cancelRecurringSubscription({ shop, accessToken, subscriptionId }) {
  const globalSubscriptionId = subscriptionId.startsWith("gid://shopify/AppSubscription/")
    ? subscriptionId
    : `gid://shopify/AppSubscription/${subscriptionId}`;
  console.log("[cancelRecurringSubscription] Cancelling subscription:", globalSubscriptionId);
  const mutation = `
    mutation CancelAppSubscription {
      appSubscriptionCancel(id: "${globalSubscriptionId}") {
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
  const response = await fetch(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: mutation }),
    }
  );
  const result = await response.json();
  console.log("[cancelRecurringSubscription] GraphQL response:", JSON.stringify(result, null, 2));
  if (!result.data || result.data.appSubscriptionCancel == null) {
    throw new Error("Unexpected response from Shopify API");
  }
  if (result.data.appSubscriptionCancel.userErrors && result.data.appSubscriptionCancel.userErrors.length > 0) {
    throw new Error(result.data.appSubscriptionCancel.userErrors[0].message);
  }
  return result.data.appSubscriptionCancel.appSubscription;
}

/**
 * Create a recurring subscription using Shopify's GraphQL API.
 *
 * @param {Object} params - Contains shop, accessToken, and returnUrl.
 * @returns {string} confirmationUrl for the subscription.
 */
async function createRecurringSubscription({ shop, accessToken, returnUrl }) {
  console.log(
    "[createRecurringSubscription] Starting fetch for shop:",
    shop,
    "with returnUrl:",
    returnUrl
  );
  const mutation = `
    mutation CreateSynclogicSubscription {
      appSubscriptionCreate(
        name: "Synclogic Paid Plan"
        returnUrl: "${returnUrl}"
        test: false
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
  const response = await fetch(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: mutation }),
    }
  );
  const result = await response.json();
  console.log("[createRecurringSubscription] GraphQL response:", JSON.stringify(result, null, 2));
  if (result.data?.appSubscriptionCreate?.userErrors?.length) {
    throw new Error(result.data.appSubscriptionCreate.userErrors[0].message);
  }
  return result.data.appSubscriptionCreate.confirmationUrl;
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
    return new Response("Authentication error", { status: 500 });
  }
  const shopDomain = session.shop.toLowerCase().trim();
  let shopSub = await prisma.shopSubscription.findUnique({
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
  return json({ shopSub });
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
    return json({ error: "Authentication error" }, { status: 500 });
  }
  const shopDomain = session.shop.toLowerCase().trim();
  const formData = await request.formData();
  const intent = formData.get("intent");
  console.log("[app.settings action] Received intent:", intent);

  // Save custom API URL settings.
  if (intent === "save-settings") {
    const customApiUrl = formData.get("customApiUrl")?.toString() || "";
    await prisma.shopSubscription.update({
      where: { shop: shopDomain },
      data: { customApiUrl },
    });
    return json({ success: true, message: "Settings saved" });
  }

  // Start a paid subscription plan.
  if (intent === "start-paid-plan") {
    const url = new URL(request.url);
    const host = url.searchParams.get("host") || "";
    const appUrl = process.env.SHOPIFY_APP_URL || "https://your-ngrok-domain.ngrok-free.app";
    const returnUrl = `${appUrl}/app/settings-callback?shop=${shopDomain}&host=${host}`;
    try {
      const confirmationUrl = await createRecurringSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
        returnUrl,
      });
      return json({ confirmationUrl });
    } catch (err) {
      return json({ error: err.message }, { status: 500 });
    }
  }

  // Cancel an active subscription.
  if (intent === "cancel-subscription") {
    try {
      // Query Shopify for the current subscriptions.
      const subscriptions = await queryActiveSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
      });
      if (!subscriptions || !subscriptions.id) {
        throw new Error("No active subscription found in Shopify");
      }
      // Cancel the subscription via Shopify API.
      const canceledSubscription = await cancelRecurringSubscription({
        shop: shopDomain,
        accessToken: session.accessToken,
        subscriptionId: subscriptions.id,
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
      return json({ success: true, message: "Subscription cancelled." });
    } catch (err) {
      return json({ error: err.message }, { status: 500 });
    }
  }

  return json({ error: "Unknown action" }, { status: 400 });
}

export default function AppSettings() {
  const { shopSub } = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const host = urlParams.get("host") || "";
  const [customUrl, setCustomUrl] = useState(shopSub.customApiUrl || "");
  const isPaidPlan = shopSub.plan === "PAID";
  const [showCancelModal, setShowCancelModal] = useState(false);
  const fetcher = useFetcher();

  useEffect(() => {
    if (actionData?.confirmationUrl) {
      window.top.location.href = actionData.confirmationUrl;
    }
  }, [actionData]);

  return (
    <Page title="Projekt: Stock Control Master Settings">
      <TitleBar title="Settings" />
      {actionData?.error && <Banner status="critical" title="Error">{actionData.error}</Banner>}
      {actionData?.success && <Banner status="success" title="Success">{actionData.message}</Banner>}
      <Layout>
        <Layout.Section oneHalf>
          <Card sectioned title="Free Plan">
            <p>
              Limited to 100 variants, includes a 7-day trial. {shopSub.plan === "FREE" && <strong>(current)</strong>}
            </p>
            <p style={{ fontWeight: 500 }}>Price: $0/month</p>
          </Card>
        </Layout.Section>
        <Layout.Section oneHalf>
          <Card sectioned title="Paid Plan">
            <p>
              Unlimited variants, includes a 7-day trial. {isPaidPlan && <strong>(current)</strong>}
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
