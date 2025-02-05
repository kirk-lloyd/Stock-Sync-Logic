import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust to your real file path

/**
 * Action function to update a variant-level metafield.
 * It builds a GraphQL mutation and sets the metafield based on the key.
 */
export async function action({ request }) {
  // 1) Get Shopify Admin API client
  const { admin } = await authenticate.admin(request);

  // 2) Parse the request body
  const { variantId, namespace, key, value } = await request.json();
  console.log("update-variant-metafield =>", { variantId, namespace, key, value });

  try {
    // 3) Build the GraphQL mutation to set a variant-level metafield
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

    // 4) Determine the metafield type based on the key
    let metafieldType = "single_line_text_field";
    if (key === "master") {
      metafieldType = "boolean";
    } else if (key === "childrenkey") {
      metafieldType = "list.variant_reference";
      // If necessary, stringify the value if it's an array
      if (Array.isArray(value)) {
        value = JSON.stringify(value);
      }
    }

    // 5) Prepare variables for the mutation
    const variables = {
      input: [
        {
          ownerId: variantId,
          namespace,
          key,
          value,
          type: metafieldType,
        },
      ],
    };

    // 6) Send the GraphQL request
    const response = await admin.graphql(mutation, { variables });
    const data = await response.json();

    // 7) Check for user errors from Shopify
    if (data?.data?.metafieldsSet?.userErrors?.length) {
      const errors = data.data.metafieldsSet.userErrors;
      console.error("Shopify metafieldsSet userErrors:", errors);
      return json({ success: false, errors }, { status: 400 });
    }

    console.log(
      "Successfully updated variant metafield:",
      data?.data?.metafieldsSet?.metafields
    );

    // 8) Return success
    return json({
      success: true,
      metafields: data?.data?.metafieldsSet?.metafields || [],
    });
  } catch (error) {
    console.error("Error in /api/update-variant-metafield action:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
}
