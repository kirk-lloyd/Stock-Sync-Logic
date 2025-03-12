// app/routes/api.verify-variant-status.jsx
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Endpoint to verify the status of a variant before adding it as a child.
 * Checks if the variant is:
 * - A master variant itself
 * - Already a child of another master variant
 * 
 * Returns:
 * - isMaster: Boolean indicating if the variant is a master
 * - isChild: Boolean indicating if the variant is a child of another product
 * - masterVariantId: ID of the master variant (if the variant is a child)
 * - masterProductTitle: Title of the product containing the master variant
 */
export const loader = async ({ request }) => {
  // Authenticate the admin request
  const { session, admin } = await authenticate.admin(request);

  // Get the variant ID from the query
  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId");
  
  if (!variantId) {
    return json({ error: "Missing variantId parameter" }, { status: 400 });
  }

  try {
    // First, check if the variant is a master itself
    const variantQuery = `
      query GetVariantDetails($id: ID!) {
        node(id: $id) {
          ... on ProductVariant {
            id
            title
            product {
              id
              title
            }
            masterMetafield: metafield(
              namespace: "projektstocksyncmaster"
              key: "master"
            ) {
              id
              value
            }
          }
        }
      }
    `;
    
    const variantResponse = await admin.graphql(variantQuery, { variables: { id: variantId } });
    const variantData = await variantResponse.json();
    
    if (variantData.errors) {
      console.error("Error fetching variant details:", variantData.errors);
      return json({ error: "Failed to fetch variant details" }, { status: 500 });
    }
    
    const variant = variantData.data.node;
    const isMaster = variant.masterMetafield?.value === "true";
    
    if (isMaster) {
      return json({
        isMaster: true,
        isChild: false,
        variantTitle: variant.title,
      });
    }
    
    // Next, check if the variant is a child of another product
    // We'll need to check for any master variants that have this variant in their children
    const query = `
      query {
        products(first: 250) {
          edges {
            node {
              id
              title
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    masterMetafield: metafield(
                      namespace: "projektstocksyncmaster"
                      key: "master"
                    ) {
                      value
                    }
                    childrenMetafield: metafield(
                      namespace: "projektstocksyncchildren"
                      key: "childrenkey"
                    ) {
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const response = await admin.graphql(query);
    const data = await response.json();
    
    if (data.errors) {
      console.error("Error fetching products:", data.errors);
      return json({ error: "Failed to fetch products" }, { status: 500 });
    }
    
    let isChild = false;
    let masterVariantId = null;
    let masterProductTitle = null;
    
    // Check each product and its variants
    for (const productEdge of data.data.products.edges) {
      const product = productEdge.node;
      
      for (const variantEdge of product.variants.edges) {
        const checkVariant = variantEdge.node;
        
        // Skip if this is not a master variant
        if (checkVariant.masterMetafield?.value !== "true") continue;
        
        // Skip if this variant doesn't have children or the children field is empty
        if (!checkVariant.childrenMetafield?.value) continue;
        
        // Parse the children array
        try {
          const childrenIds = JSON.parse(checkVariant.childrenMetafield.value);
          
          // Check if our variant is in the children array
          if (childrenIds.includes(variantId)) {
            isChild = true;
            masterVariantId = checkVariant.id;
            masterProductTitle = product.title;
            break;
          }
        } catch (error) {
          console.error("Error parsing children metafield:", error);
          continue;
        }
      }
      
      if (isChild) break;
    }
    
    return json({
      isMaster,
      isChild,
      masterVariantId,
      masterProductTitle,
      variantTitle: variant.title,
    });
    
  } catch (error) {
    console.error("Error in verify-variant-status API:", error);
    return json({ error: "Failed to verify variant status" }, { status: 500 });
  }
};