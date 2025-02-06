import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust path as needed

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    // 1) Parse the JSON body from the client
    const { variantId, newQuantity } = await request.json();
    if (!variantId) {
      throw new Error("No variantId provided.");
    }

    // --------------------------------------------------------------------------------
    // PART A: Fetch the primary (master?) variant to see if it's Master and get children
    // --------------------------------------------------------------------------------
    const variantDataResponse = await admin.graphql(
      `#graphql
      query getVariantData($id: ID!) {
        productVariant(id: $id) {
          id
          inventoryQuantity
          inventoryItem {
            id
          }
          # Check if this variant is master
          masterMetafield: metafield(namespace: "projektstocksyncmaster", key: "master") {
            value
          }
          # If it is master, we parse children from here
          childrenMetafield: metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
            value
          }
        }
      }
      `,
      {
        variables: {
          id: variantId,
        },
      }
    );

    const variantDataJson = await variantDataResponse.json();
    const masterVariantNode = variantDataJson?.data?.productVariant;
    if (!masterVariantNode) {
      throw new Error(`Could not find variant with ID: ${variantId}`);
    }

    // If we have no inventoryItem, we cannot proceed
    if (!masterVariantNode?.inventoryItem?.id) {
      throw new Error("Could not find inventoryItem for this variant.");
    }

    // 2) Decide the delta for the Master variant and update it
    //    "newQuantity" is the final quantity desired. We compute the difference.
    const masterCurrentQuantity = masterVariantNode.inventoryQuantity ?? 0;
    const masterDelta = newQuantity - masterCurrentQuantity;
    // We use the same location each time (replace with your real location ID)
    const locationId = "gid://shopify/Location/79544844508";

    // If there's any difference, adjust the Master variant's inventory
    if (masterDelta !== 0) {
      await adjustVariantInventory({
        admin,
        inventoryItemId: masterVariantNode.inventoryItem.id,
        locationId,
        delta: masterDelta,
      });
    }

    // 3) Check if this variant is Master
    const isMaster = masterVariantNode?.masterMetafield?.value === "true";
    let childVariantIds = [];

    if (isMaster && masterVariantNode?.childrenMetafield?.value) {
      try {
        const parsedChildren = JSON.parse(masterVariantNode.childrenMetafield.value);
        if (Array.isArray(parsedChildren)) {
          childVariantIds = parsedChildren;
        }
      } catch (error) {
        console.error("Error parsing children for master variant:", error);
      }
    }

    // 4) If it is Master, update each child’s inventory to match newQuantity
    if (isMaster && childVariantIds.length > 0) {
      // For each child variant, do the same inventory logic: fetch current quantity -> compute delta -> adjust
      await Promise.all(
        childVariantIds.map(async (childId) => {
          // Fetch child's inventory info
          const childDataResponse = await admin.graphql(
            `#graphql
            query getChildInventoryItem($childId: ID!) {
              productVariant(id: $childId) {
                id
                inventoryQuantity
                inventoryItem {
                  id
                }
              }
            }
            `,
            {
              variables: {
                childId,
              },
            }
          );

          const childDataJson = await childDataResponse.json();
          const childVariantNode = childDataJson?.data?.productVariant;
          if (
            !childVariantNode ||
            !childVariantNode.inventoryItem?.id
          ) {
            console.error("Could not find inventoryItem for child variant:", childId);
            return;
          }

          const childCurrentQuantity = childVariantNode.inventoryQuantity ?? 0;
          const childDelta = newQuantity - childCurrentQuantity;

          if (childDelta !== 0) {
            await adjustVariantInventory({
              admin,
              inventoryItemId: childVariantNode.inventoryItem.id,
              locationId,
              delta: childDelta,
            });
          }
        })
      );
    }

    // 5) Return success response
    return json({ success: true, newQuantity });
  } catch (error) {
    console.error("Error updating inventory:", error);
    return json({ error: error.message }, { status: 400 });
  }
};

/**
 * Helper function to adjust inventory for a single inventoryItem in a single location.
 * Uses Shopify's `inventoryAdjustQuantities` GraphQL mutation.
 */
async function adjustVariantInventory({ admin, inventoryItemId, locationId, delta }) {
  // Skip if delta = 0 (no change needed)
  if (!delta) return;

  const adjustResponse = await admin.graphql(
    `#graphql
    mutation AdjustInventoryQuantities($inventoryItemId: ID!, $locationId: ID!, $delta: Int!) {
      inventoryAdjustQuantities(
        input: {
          reason: "correction",
          name: "available",
          changes: [
            {
              delta: $delta,
              inventoryItemId: $inventoryItemId,
              locationId: $locationId
            }
          ]
        }
      ) {
        inventoryAdjustmentGroup {
          createdAt
          reason
          changes {
            name
            delta
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: { inventoryItemId, locationId, delta },
    }
  );

  const adjustData = await adjustResponse.json();
  const userErrors = adjustData?.data?.inventoryAdjustQuantities?.userErrors;
  if (userErrors && userErrors.length > 0) {
    throw new Error(
      "UserErrors from inventoryAdjustQuantities: " + JSON.stringify(userErrors)
    );
  }
}
