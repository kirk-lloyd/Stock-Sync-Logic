import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * API endpoint to manually start a bulk operation for syncing product data
 * This allows refreshing product data on demand from the UI
 */
export async function action({ request }) {
  try {
    // Get the Shopify Admin API client
    const { admin } = await authenticate.admin(request);
    
    // Start the bulk operation using the GraphQL mutation
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
    
    // Execute the GraphQL mutation
    const response = await admin.graphql(mutation);
    const data = await response.json();
    
    // Check for errors
    if (data?.data?.bulkOperationRunQuery?.userErrors?.length > 0) {
      const errors = data.data.bulkOperationRunQuery.userErrors;
      console.error("Shopify API errors when starting bulk operation:", errors);
      return json({ success: false, errors }, { status: 400 });
    }
    
    // Log success information
    console.log("Successfully started bulk operation:", data?.data?.bulkOperationRunQuery?.bulkOperation);
    
    // Return success response
    return json({
      success: true,
      bulkOperation: data?.data?.bulkOperationRunQuery?.bulkOperation
    });
  } catch (error) {
    console.error("Error starting bulk operation:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
}