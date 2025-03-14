// app/api/sync-variant-update.js
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust path as needed

/**
 * Action for updating a single variant synchronously.
 *
 * Expects a POST request with a JSON body containing:
 *  - variantId: Shopify variant ID (GID)
 *  - title: (optional) new title for the variant
 *  - inventory: new inventory quantity (number)
 *  - master: a boolean ("true" if the variant is a master)
 *  - children: an array of child variant IDs (will be stored as a JSON string in the metafield)
 *
 * The mutation updates the variant via Shopify's productVariantUpdate mutation.
 * In this example, we update the title and inventory. We also update the custom metafields
 * for the master flag and children assignments.
 */
export const action = async ({ request }) => {
  // Ensure we have a POST request.
  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  // Parse the incoming JSON body.
  const { variantId, title, inventory, master, children } = await request.json();
  if (!variantId) {
    return json({ error: "Missing variantId" }, { status: 400 });
  }

  // Authenticate the admin request.
  const { session, admin } = await authenticate.admin(request);

  // Build the mutation.
  // We use productVariantUpdate to update the variant.
  // Note: Depending on your Shopify Admin API version, updating inventory may require separate mutations.
  // Here we assume a simple update for demonstration.
  const mutation = `
    mutation UpdateVariant($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant {
          id
          title
          inventoryQuantity
          masterMetafield: metafield(namespace: "projektstocksyncmaster", key: "master") {
            id
            value
          }
          childrenMetafield: metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
            id
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // Construct the input object.
  // Note: Shopify expects the ID as is. We update title and inventoryQuantity.
  // We assume that metafield updates for master and children are handled via the same mutation.
  const input = {
    id: variantId,
    title, // if title is provided, it will update
    inventoryQuantity: Number(inventory),
    // You may need to update metafields separately if required.
    // For example, you could use additional mutations to update the master and children metafields.
  };

  // Execute the mutation.
  const response = await admin.graphql(mutation, { variables: { input } });
  const result = await response.json();

  // Check for errors.
  if (result.data.productVariantUpdate.userErrors.length > 0) {
    const errorMsg = result.data.productVariantUpdate.userErrors[0].message;
    return json({ error: errorMsg }, { status: 400 });
  }

  // Now, update the custom metafields if needed.
  // For master flag (using boolean type):
  const updateMasterMetafieldMutation = `
    mutation UpdateMasterMetafield($variantId: ID!, $value: Boolean!) {
      productVariantUpdate(input: { id: $variantId, metafields: [{ namespace: "projektstocksyncmaster", key: "master", value: $value, type: "boolean" }] }) {
        productVariant {
          id
          masterMetafield: metafield(namespace: "projektstocksyncmaster", key: "master") {
            id
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  await admin.graphql(updateMasterMetafieldMutation, {
    variables: { variantId, value: master }, // Use boolean directly
  });

  // For children assignment (using list.variant_reference type):
  // Note: This expects an array of variant IDs
  const updateChildrenMetafieldMutation = `
    mutation UpdateChildrenMetafield($variantId: ID!, $value: String!) {
      productVariantUpdate(input: { id: $variantId, metafields: [{ namespace: "projektstocksyncchildren", key: "childrenkey", value: $value, type: "list.variant_reference" }] }) {
        productVariant {
          id
          childrenMetafield: metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
            id
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  
  // Pass the array directly if it's already in the correct format
  // or convert it to the proper format if needed
  await admin.graphql(updateChildrenMetafieldMutation, {
    variables: { variantId, value: JSON.stringify(children) },
  });

  // Finally, perform a synchronous query to fetch the updated variant data.
  const syncQuery = `
    query GetVariant($id: ID!) {
      node(id: $id) {
        ... on ProductVariant {
          id
          title
          inventoryQuantity
          image {
            originalSrc
          }
          masterMetafield: metafield(namespace: "projektstocksyncmaster", key: "master") {
            id
            value
          }
          childrenMetafield: metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
            id
            value
          }
          product {
            id
            title
            images(first: 1) {
              edges {
                node {
                  originalSrc
                }
              }
            }
          }
        }
      }
    }
  `;
  const syncResponse = await admin.graphql(syncQuery, { variables: { id: variantId } });
  const syncResult = await syncResponse.json();
  if (syncResult.errors) {
    console.error("Error fetching updated variant:", syncResult.errors);
    return json({ error: "Error fetching updated variant data" }, { status: 500 });
  }
  
  // Return the updated variant data.
  return json({ product: syncResult.data.node });
};