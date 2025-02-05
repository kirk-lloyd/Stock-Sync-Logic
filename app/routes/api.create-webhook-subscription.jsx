// ./api/create-webhook-subscription.jsx
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust path as needed

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  // Replace with your actual public endpoint URL
  const callbackUrl = "https://ca-irish-demographic-creations.trycloudflare.com/webhooks/inventory-update";

  const mutation = `#graphql
    mutation webhookSubscriptionCreate($callbackUrl: URL!) {
      webhookSubscriptionCreate(
        topic: INVENTORY_LEVELS_UPDATE,
        webhookSubscription: {
          callbackUrl: $callbackUrl,
          format: JSON
        }
      ) {
        webhookSubscription {
          id
          topic
          createdAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const variables = { callbackUrl };

  const response = await admin.graphql(mutation, { variables });
  const data = await response.json();
  if (data.data.webhookSubscriptionCreate.userErrors.length > 0) {
    console.error("Error creating webhook subscription:", data.data.webhookSubscriptionCreate.userErrors);
    return json({ success: false, errors: data.data.webhookSubscriptionCreate.userErrors }, { status: 400 });
  }
  console.log("Webhook subscription created:", data.data.webhookSubscriptionCreate.webhookSubscription);
  return json({ success: true, subscription: data.data.webhookSubscriptionCreate.webhookSubscription });
};
