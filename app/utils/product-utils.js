/**
 * Product Utility Functions
 * Shared utility functions for product and variant management
 */

/**
 * Extracts the numeric part from a Shopify GID string
 * @param {string} gid - The Shopify GID string (e.g., "gid://shopify/ProductVariant/12345")
 * @returns {string} The extracted numeric ID
 */
export function parseVariantId(gid = "") {
    return gid.split("/").pop();
  }
  
  /**
   * Initiates a bulk operation to fetch all product data
   * @param {Object} admin - Shopify admin API client
   * @returns {Object} The response from the bulk operation
   */
  export async function startBulkOperation(admin) {
    console.log("Starting a new bulk operation…");
    const mutation = `
      mutation {
        bulkOperationRunQuery(
          query: """
          {
            products {
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
                  metafields(first: 30) {
                    edges {
                      node {
                        namespace
                        key
                        value
                      }
                    }
                  }
                  variants(first: 100) {
                    edges {
                      node {
                        id
                        title
                        inventoryQuantity
                        image {
                          id
                          originalSrc
                        }
                        masterMetafield: metafield(
                          namespace: "projektstocksyncmaster"
                          key: "master"
                        ) {
                          id
                          value
                        }
                        childrenMetafield: metafield(
                          namespace: "projektstocksyncchildren"
                          key: "childrenkey"
                        ) {
                          id
                          value
                        }
                        parentMasterMetafield: metafield(
                          namespace: "projektstocksyncparentmaster"
                          key: "parentmaster"
                        ) {
                          id
                          value
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          """
        ) {
          bulkOperation {
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
    const response = await admin.graphql(mutation);
    const data = await response.json();
    console.log("startBulkOperation response =>", data);
    return data;
  }
  
  /**
   * Checks the status of the current bulk operation
   * @param {Object} admin - Shopify admin API client
   * @returns {Object|null} The current bulk operation status or null if none exists
   */
  export async function checkBulkOperationStatus(admin) {
    const query = `
      query {
        currentBulkOperation {
          id
          status
          errorCode
          createdAt
          completedAt
          objectCount
          fileSize
          url
        }
      }
    `;
    const response = await admin.graphql(query);
    const data = await response.json();
    const currentOp = data?.data?.currentBulkOperation || null;
    console.log("Result of checkBulkOperationStatus =>", currentOp);
    return currentOp;
  }
  
  /**
   * Fetches the results of a completed bulk operation
   * @param {string} fileUrl - The URL to the bulk operation results file
   * @returns {Array} Parsed nodes from the JSONL file
   */
  export async function fetchBulkResults(fileUrl) {
    const res = await fetch(fileUrl);
    const textData = await res.text();
    const lines = textData.split("\n").filter(Boolean);
    const allNodes = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        allNodes.push(record);
      } catch (err) {
        console.error("Error parsing a JSONL line:", err);
      }
    }
    return allNodes;
  }
  
  /**
   * Reconstructs product objects from flat bulk operation results
   * @param {Array} allNodes - Flat array of nodes from bulk operation
   * @returns {Array} Restructured product objects with nested variants, images, and metafields
   */
  export function rebuildNestedProducts(allNodes) {
    const productMap = {};
    for (const node of allNodes) {
      if (!node.__parentId) {
        productMap[node.id] = {
          ...node,
          images: { edges: [] },
          metafields: { edges: [] },
          variants: { edges: [] },
        };
      }
    }
    for (const node of allNodes) {
      if (node.__parentId) {
        const parent = productMap[node.__parentId];
        if (!parent) continue;
        if (node.inventoryQuantity !== undefined) {
          if (
            node.title &&
            node.title.trim().toLowerCase() === "untitled variant"
          ) {
            continue;
          }
          parent.variants.edges.push({ node });
        } else if (node.originalSrc) {
          parent.images.edges.push({ node });
        } else if (node.namespace && node.key && node.value) {
          parent.metafields.edges.push({ node });
        }
      }
    }
    return Object.values(productMap);
  }
  
  /**
   * Processes raw product data to add master/child relationships and other derived fields
   * @param {Array} reassembledProducts - The reassembled product objects
   * @returns {Array} Products with processed variant data
   */
  export function processProductData(reassembledProducts) {
    return reassembledProducts.map((product) => {
      const updatedVariants = product.variants.edges.map((vEdge) => {
        const variant = vEdge.node;
        const isMaster = variant.masterMetafield?.value === "true";
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
          
          if (parentMasterValue !== "[]") {
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
          ...variant, 
          isMaster, 
          childVariantIds,
          parentMasterId,
          hasParentMaster,
          rawParentMasterValue: variant.parentMasterMetafield?.value || null
        };
      });
      return { ...product, variants: { edges: updatedVariants.map((v) => ({ node: v })) } };
    });
  }
  
  /**
   * Fetches the latest product data for a specific variant
   * @param {string} variantId - The ID of the variant to refresh
   * @returns {Object} The updated product data
   */
  export async function refreshProductData(variantId) {
    try {
      const response = await fetch(`/api/sync-product?variantId=${encodeURIComponent(variantId)}`);
      if (!response.ok) {
        throw new Error("Failed to refresh product data");
      }
      const data = await response.json();
      return data.product;
    } catch (error) {
      console.error("Error refreshing product data:", error);
      throw error;
    }
  }
  
  /**
   * Updates the master metafield for a variant
   * @param {string} variantId - The ID of the variant to update
   * @param {boolean} isMaster - Whether the variant should be marked as master
   * @returns {Promise} The result of the API call
   */
  export async function updateMasterMetafield(variantId, isMaster) {
    try {
      const response = await fetch("/api/update-variant-metafield", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId,
          namespace: "projektstocksyncmaster",
          key: "master",
          value: isMaster ? "true" : "false",
        }),
      });
      if (!response.ok) throw new Error("Failed to update the 'master' metafield");
      return response.json();
    } catch (error) {
      console.error("Error updating 'master' metafield:", error);
      throw error;
    }
  }