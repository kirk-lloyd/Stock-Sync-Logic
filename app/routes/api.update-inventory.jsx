import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust path if needed

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    // 1) Parse the JSON body from the client
    const { variantId, newQuantity } = await request.json();
    if (!variantId) {
      throw new Error("No variantId provided.");
    }

    // --------------------------------------------------------------------------------
    // PART A: Fetch the primary (master) variant to check if it's Master and obtain children
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

    // If there is no inventoryItem, we cannot proceed
    if (!masterVariantNode?.inventoryItem?.id) {
      throw new Error("Could not find inventoryItem for this variant.");
    }

    // 2) Determine how much to adjust the Master variant inventory by
    //    "newQuantity" is the final quantity desired. We compute the difference (delta).
    const masterCurrentQuantity = masterVariantNode.inventoryQuantity ?? 0;
    const masterDelta = newQuantity - masterCurrentQuantity;

    // NEW: Fetch the store's locations to avoid hardcoding
    const locationResponse = await admin.graphql(
      `#graphql
      query getLocations {
        locations(first: 10) {
          edges {
            node {
              id
              name
              isActive
              isPrimary
            }
          }
        }
      }
      `
    );

    const locationData = await locationResponse.json();
    const locationEdges = locationData?.data?.locations?.edges || [];

    if (locationEdges.length === 0) {
      throw new Error("Could not find any locations for this store.");
    }

    // Try to find the primary location first
    let selectedLocation = locationEdges.find(edge => edge.node.isPrimary && edge.node.isActive);

    // If no primary location, take the first active one
    if (!selectedLocation) {
      selectedLocation = locationEdges.find(edge => edge.node.isActive);
    }

    // If still no location, take any available location
    if (!selectedLocation) {
      selectedLocation = locationEdges[0];
    }

    const locationId = selectedLocation.node.id;
    console.log(`Using location: ${selectedLocation.node.name} (${locationId})`);

    // If there's any difference, adjust the Master variant's inventory
    if (masterDelta !== 0) {
      await adjustVariantInventory({
        admin,
        inventoryItemId: masterVariantNode.inventoryItem.id,
        locationId,
        delta: masterDelta,
      });
    }

    // 3) Determine if this variant is actually Master
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

    // 4) The following block that updates each child's inventory
    //    has been commented out so that ONLY the Master is updated.

/*
    if (isMaster && childVariantIds.length > 0) {
      // For each child variant, do the same inventory logic: fetch current quantity -> compute delta -> adjust
      await Promise.all(
        childVariantIds.map(async (childId) => {
          // Fetch child's inventory info
          const childDataResponse = await admin.graphql(
            \`#graphql
            query getChildInventoryItem($childId: ID!) {
              productVariant(id: $childId) {
                id
                inventoryQuantity
                inventoryItem {
                  id
                }
              }
            }
            \`,
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
*/

    // 5) Return success response
    return json({ success: true, newQuantity });
  } catch (error) {
    console.error("Error updating inventory:", error);
    return json({ error: error.message }, { status: 400 });
  }
};

/**
 * Helper function to adjust inventory for a single inventoryItem in a specified location.
 * It uses Shopify's `inventoryAdjustQuantities` GraphQL mutation.
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