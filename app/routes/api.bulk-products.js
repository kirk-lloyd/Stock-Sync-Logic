import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * API endpoint to fetch paginated products for the Add Children modal
 * Implements nested pagination to support more than 250 variants per product
 * 
 * This endpoint provides two modes of operation:
 * 1. Regular product pagination - fetches a page of products with their variants
 * 2. Variant pagination - fetches additional variants for a specific product
 */
export async function loader({ request }) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '10', 10);
  const searchQuery = searchParams.get('q') || '';
  const cursor = searchParams.get('cursor');
  // Parameter for variant pagination
  const variantCursor = searchParams.get('variantCursor'); 
  // Specific product to fetch more variants
  const specificProductId = searchParams.get('productId');
  
  console.log("API request params:", { 
    limit, 
    searchQuery, 
    cursor, 
    variantCursor,
    specificProductId 
  });
  
  try {
    // Get the Shopify Admin API client
    const { admin } = await authenticate.admin(request);
    
    // If we're requesting additional variants for a specific product
    if (specificProductId && variantCursor) {
      // Query to fetch more variants from a specific product
      const variantQuery = `
        query($productId: ID!, $after: String) {
          product(id: $productId) {
            id
            title
            variants(first: 250, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  title
                  sku
                  inventoryQuantity
                  image {
                    originalSrc
                  }
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
                  parentMasterMetafield: metafield(
                    namespace: "projektstocksyncparentmaster"
                    key: "parentmaster"
                  ) {
                    value
                  }
                }
              }
            }
          }
        }
      `;
      
      const variantResponse = await admin.graphql(variantQuery, {
        variables: {
          productId: specificProductId,
          after: variantCursor
        }
      });
      
      const variantData = await variantResponse.json();
      
      // Process the additional variants
      const processedVariants = variantData.data.product.variants.edges.map(variantEdge => {
        const variant = variantEdge.node;
        const isMaster = variant.masterMetafield?.value === "true";
        
        // Process metafields as before
        let childVariantIds = [];
        if (isMaster && variant.childrenMetafield?.value) {
          try {
            const parsedArr = JSON.parse(variant.childrenMetafield.value);
            if (Array.isArray(parsedArr)) {
              childVariantIds = parsedArr;
            }
          } catch (err) {
            console.error("Error parsing children for variant", variant.id, err);
          }
        }
        
        let parentMasterId = null;
        let hasParentMaster = false;
        
        if (variant.parentMasterMetafield && variant.parentMasterMetafield.value) {
          const parentMasterValue = variant.parentMasterMetafield.value;
          
          if (parentMasterValue !== "[]" && parentMasterValue !== "null") {
            hasParentMaster = true;
            
            try {
              const parsed = JSON.parse(parentMasterValue);
              
              if (Array.isArray(parsed) && parsed.length > 0) {
                parentMasterId = parsed[0];
              } else if (typeof parsed === "string") {
                parentMasterId = parsed;
              } else if (parsed && typeof parsed === "object") {
                parentMasterId = String(parsed);
              }
            } catch (e) {
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
            image: variant.image ? { originalSrc: variant.image.originalSrc } : null,
            isMaster,
            childVariantIds,
            hasParentMaster,
            parentMasterId,
            rawParentMasterValue: variant.parentMasterMetafield?.value || null,
            productTitle: variantData.data.product.title // Add product title
          }
        };
      });
      
      // Return just the additional variants
      return json({
        additionalVariants: processedVariants,
        productId: specificProductId,
        productTitle: variantData.data.product.title,
        pageInfo: variantData.data.product.variants.pageInfo
      });
    }
    
    // Main query to fetch products
    const query = `
      query($query: String, $first: Int, $after: String) {
        products(first: $first, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
          edges {
            node {
              id
              title
              createdAt
              images(first: 1) {
                edges {
                  node {
                    originalSrc
                  }
                }
              }
              variants(first: 250) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                edges {
                  node {
                    id
                    title
                    sku
                    inventoryQuantity
                    image {
                      originalSrc
                    }
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
                    parentMasterMetafield: metafield(
                      namespace: "projektstocksyncparentmaster"
                      key: "parentmaster"
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
    
    // Variables for the GraphQL query
    const variables = {
      query: searchQuery,
      first: limit
    };
    
    if (cursor) {
      variables.after = cursor;
    }
    
    console.log("GraphQL variables:", variables);
    
    // Execute the GraphQL query
    const response = await admin.graphql(query, { variables });
    const { data } = await response.json();
    
    console.log("GraphQL response received. Products count:", data.products.edges.length);
    
    // Process products and variants according to expected structure
    const products = [];
    // Save information about products with more variants
    const productsWithMoreVariants = [];
    
    for (const edge of data.products.edges) {
      const product = edge.node;
      
      // Only include products with variants
      if (product.variants && product.variants.edges && product.variants.edges.length > 0) {
        // Check if there are more variants available
        if (product.variants.pageInfo.hasNextPage) {
          productsWithMoreVariants.push({
            id: product.id,
            title: product.title,
            cursor: product.variants.pageInfo.endCursor
          });
        }
        
        const processedVariantEdges = product.variants.edges.map(variantEdge => {
          const variant = variantEdge.node;
          const isMaster = variant.masterMetafield?.value === "true";
          
          // Process child variant IDs
          let childVariantIds = [];
          if (isMaster && variant.childrenMetafield?.value) {
            try {
              const parsedArr = JSON.parse(variant.childrenMetafield.value);
              if (Array.isArray(parsedArr)) {
                childVariantIds = parsedArr;
              }
            } catch (err) {
              console.error("Error parsing children for variant", variant.id, err);
            }
          }
          
          // Process parent master metafield
          let parentMasterId = null;
          let hasParentMaster = false;
          
          if (variant.parentMasterMetafield && variant.parentMasterMetafield.value) {
            const parentMasterValue = variant.parentMasterMetafield.value;
            
            if (parentMasterValue !== "[]" && parentMasterValue !== "null") {
              hasParentMaster = true;
              
              try {
                const parsed = JSON.parse(parentMasterValue);
                
                if (Array.isArray(parsed) && parsed.length > 0) {
                  parentMasterId = parsed[0];
                } else if (typeof parsed === "string") {
                  parentMasterId = parsed;
                } else if (parsed && typeof parsed === "object") {
                  parentMasterId = String(parsed);
                }
              } catch (e) {
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
              image: variant.image ? { originalSrc: variant.image.originalSrc } : null,
              isMaster,
              childVariantIds,
              hasParentMaster,
              parentMasterId,
              rawParentMasterValue: variant.parentMasterMetafield?.value || null
            }
          };
        });
        
        products.push({
          id: product.id,
          title: product.title,
          image: product.images?.edges?.[0]?.node?.originalSrc || null,
          variants: {
            edges: processedVariantEdges,
            pageInfo: product.variants.pageInfo
          }
        });
      }
    }
    
    console.log("Processed products:", products.length);
    console.log("Products with more variants:", productsWithMoreVariants.length);
    
    // Calculate variant count in this page
    const pageVariantCount = products.reduce(
      (acc, product) => acc + product.variants.edges.length, 
      0
    );
    
    console.log("Page variant count:", pageVariantCount);
    
    // For total estimate, use a conservative approach
    // Assume each product with more variants has at least 250 more
    const moreVariantsEstimate = productsWithMoreVariants.length * 250;
    const estimatedTotal = pageVariantCount + moreVariantsEstimate;
    
    // Prepare the response
    const result = {
      products,
      pageInfo: data.products.pageInfo,
      totalCount: pageVariantCount,
      estimatedTotalCount: estimatedTotal,
      productsWithMoreVariants: productsWithMoreVariants
    };
    
    return json(result);
  } catch (error) {
    console.error("Error fetching products:", error);
    return json({ 
      error: error.message, 
      products: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
      totalCount: 0,
      estimatedTotalCount: 0
    }, { status: 500 });
  }
}