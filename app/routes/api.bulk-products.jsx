import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * API endpoint to fetch paginated products for the Add Children modal
 * This returns products with detailed parent-child information
 */
export async function loader({ request }) {
  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '10', 10);
  const searchQuery = searchParams.get('q') || '';
  
  try {
    // Get the Shopify Admin API client
    const { admin } = await authenticate.admin(request);
    
    // Build a query to get products with variants and their parent-master relationships
    // This gives us current, up-to-date information about which variants are already children
    const query = `
      query($query: String, $first: Int, $after: String) {
        products(first: $first, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            images(first: 1) {
              nodes {
                originalSrc
              }
            }
            variants(first: 100) {
              nodes {
                id
                title
                inventoryQuantity
                sku
                image {
                  originalSrc
                }
                metafield(namespace: "projektstocksyncmaster", key: "master") {
                  value
                }
                parentMaster: metafield(namespace: "projektstocksyncparentmaster", key: "parentmaster") {
                  value
                }
              }
            }
          }
        }
      }
    `;
    
    // Calculate pagination
    const first = 10; // Number of products per page
    let after = null;
    if (page > 1) {
      // This is a simple approach - in production, you'd want to cache cursors
      const previousPageQuery = await admin.graphql(query, {
        variables: {
          query: searchQuery,
          first: first * (page - 1),
          after: null
        }
      });
      const previousPageData = await previousPageQuery.json();
      after = previousPageData.data.products.pageInfo.endCursor;
    }
    
    // Execute the GraphQL query with pagination parameters
    const response = await admin.graphql(query, {
      variables: {
        query: searchQuery,
        first,
        after
      }
    });
    const { data } = await response.json();
    
    // Process the products and variants
    const products = data.products.nodes.map(product => {
      return {
        id: product.id,
        title: product.title,
        image: product.images.nodes[0]?.originalSrc || null,
        variants: {
          edges: product.variants.nodes.map(variant => {
            // Determine if this variant is a master
            const isMaster = variant.metafield?.value === "true";
            
            // Determine if this variant has a parent master
            let hasParentMaster = false;
            let parentMasterId = null;
            
            if (variant.parentMaster && variant.parentMaster.value) {
              const parentMasterValue = variant.parentMaster.value;
              
              // Check if the value is non-empty
              if (parentMasterValue && parentMasterValue !== "[]") {
                hasParentMaster = true;
                
                try {
                  // Try to parse as JSON array
                  const parsed = JSON.parse(parentMasterValue);
                  if (Array.isArray(parsed) && parsed.length > 0) {
                    parentMasterId = parsed[0];
                  } else if (typeof parsed === "string") {
                    parentMasterId = parsed;
                  }
                } catch (e) {
                  // If parsing fails, use the raw value
                  parentMasterId = parentMasterValue;
                }
              }
            }
            
            return {
              node: {
                id: variant.id,
                title: variant.title,
                sku: variant.sku || '',
                inventoryQuantity: variant.inventoryQuantity || 0,
                image: variant.image ? { originalSrc: variant.image.originalSrc } : 
                    (product.images.nodes[0] ? { originalSrc: product.images.nodes[0].originalSrc } : null),
                isMaster,
                hasParentMaster,
                parentMasterId,
                rawParentMasterValue: variant.parentMaster?.value || null
              }
            };
          })
        }
      };
    });
    
    // Return the processed data
    return json({
      products,
      pageInfo: data.products.pageInfo,
      totalCount: data.products.nodes.reduce((acc, product) => acc + product.variants.nodes.length, 0)
    });
  } catch (error) {
    console.error("Error fetching products for Add Children modal:", error);
    return json({ error: error.message }, { status: 500 });
  }
}