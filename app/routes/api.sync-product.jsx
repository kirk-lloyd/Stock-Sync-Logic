// app/api/sync-product.js
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust the path as needed

/**
 * Loader for fetching the latest data for a single variant.
 * Expects a query parameter "variantId".
 *
 * The GraphQL query retrieves:
 *  - The variant's basic info (id, title, inventoryQuantity, image, sku)
 *  - The master metafield ("projektstocksyncmaster") and children metafield ("projektstocksyncchildren")
 *  - The product context (id, title, first image)
 *
 * The endpoint returns a JSON object with the property "product" containing the variant details.
 */
export const loader = async ({ request }) => {
  // Parse the query parameter.
  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId");
  if (!variantId) {
    throw new Response("Missing variantId", { status: 400 });
  }
  
  // Authenticate the admin request.
  const { session, admin } = await authenticate.admin(request);
  
  // Build the GraphQL query for a single variant.
  const query = `
    query GetVariant($id: ID!) {
      node(id: $id) {
        ... on ProductVariant {
          id
          title
          sku
          inventoryQuantity
          image {
            originalSrc
          }
          masterMetafield: metafield(namespace: "projektstocksyncmaster", key: "master") {
            id
            value
          }
          ratioMetafield: metafield(
            namespace: "projektstocksyncqtymanagement"
            key: "qtymanagement"
          ) {
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
  
  // Execute the GraphQL query.
  const response = await admin.graphql(query, { variables: { id: variantId } });
  const result = await response.json();
  if (result.errors) {
    console.error("Error fetching variant:", result.errors);
    throw new Response("Error fetching variant data", { status: 500 });
  }
  
  // Return the variant data in a property "product".
  return json({ product: result.data.node });
};