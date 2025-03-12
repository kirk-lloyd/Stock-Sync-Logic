import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust this path as needed

/**
 * Action function to update a variant-level metafield.
 * Builds a GraphQL mutation and sets the metafield based on the key.
 * Handles multiple metafield types including parent-master relationships.
 */
export async function action({ request }) {
  // 1) Get the Shopify Admin API client.
  const { admin } = await authenticate.admin(request);
  
  // 2) Parse the request body.
  let { variantId, namespace, key, value } = await request.json();
  console.log("update-variant-metafield =>", { variantId, namespace, key, value });
  
  try {
    // 3) Build the GraphQL mutation to set a variant-level metafield.
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
    
    // 4) Determine the metafield type based on the key.
    let metafieldType = "single_line_text_field";
    
    if (key === "master") {
      metafieldType = "boolean";
    } 
    else if (key === "childrenkey") {
      metafieldType = "list.variant_reference";
      // Stringify the value if it's an array.
      if (Array.isArray(value)) {
        value = JSON.stringify(value);
      }
    } 
    else if (key === "parentmaster") {
      // For parent master reference - stores which master this variant belongs to
      metafieldType = "list.variant_reference";
      
      // Handle the value formatting for list.variant_reference
      if (!value || value === '') {
        // Empty array for clearing the reference
        value = JSON.stringify([]);
      } else {
        // Ensure the value is wrapped in an array and properly JSON stringified
        // If it's already an array, use it as is; otherwise, wrap the single value
        const valueArray = Array.isArray(value) ? value : [value];
        value = JSON.stringify(valueArray);
      }
    }
    else if (key === "qtymanagement") {
      // For qtymanagement, we expect an integer value.
      metafieldType = "number_integer";
      // Ensure the value is an integer represented as a string.
      value = String(parseInt(value, 10));
    }
    
    // 5) Prepare variables for the mutation.
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
    
    // 6) Send the GraphQL request.
    const response = await admin.graphql(mutation, { variables });
    const data = await response.json();
    
    // 7) Check for user errors from Shopify.
    if (data?.data?.metafieldsSet?.userErrors?.length) {
      const errors = data.data.metafieldsSet.userErrors;
      console.error("Shopify metafieldsSet userErrors:", errors);
      return json({ success: false, errors }, { status: 400 });
    }
    
    console.log(
      "Successfully updated variant metafield:",
      data?.data?.metafieldsSet?.metafields
    );
    
    // 8) Return success.
    return json({
      success: true,
      metafields: data?.data?.metafieldsSet?.metafields || [],
    });
  } catch (error) {
    console.error("Error in /api/update-variant-metafield action:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
}