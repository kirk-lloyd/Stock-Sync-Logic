import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust to your real path

/**
 * Action function to update a variant-level metafield.
 */
export async function action({ request }) {
  // 1) Get the Shopify Admin API client
  const { admin } = await authenticate.admin(request);

  // 2) Parse the request body from JSON
  const { variantId, namespace, key, value } = await request.json();
  console.log("action => update-variant-metafield", { variantId, namespace, key, value });

  // 3) Call Shopify's GraphQL Admin API to set the metafield
  try {
    const mutation = `#graphql
      mutation metafieldsSetVariant($input: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $input) {
          metafields {
            id
            namespace
            key
            value
            ownerType
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // Note: For a boolean metafield, use a string "boolean"
    const variables = {
      input: [
        {
          ownerId: variantId,
          namespace,
          key,
          type: "boolean", // Use "boolean" as a string value for the type
          value,
        },
      ],
    };

    const response = await admin.graphql(mutation, { variables });
    const data = await response.json();
    console.log("metafieldsSet response:", JSON.stringify(data, null, 2));

    if (data?.data?.metafieldsSet?.userErrors?.length) {
      const errors = data.data.metafieldsSet.userErrors;
      console.error("Shopify userErrors:", errors);
      return json({ success: false, errors }, { status: 400 });
    }

    return json({
      success: true,
      metafields: data?.data?.metafieldsSet?.metafields || [],
    });
  } catch (error) {
    console.error("Error in update-variant-metafield action:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
}
