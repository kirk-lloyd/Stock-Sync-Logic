import { json } from "@remix-run/node";
import crypto from "crypto";

// ------------------------------------------------------------------
// 1) Verify HMAC signature
// ------------------------------------------------------------------
function verifyHmac(body, hmacHeader, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");

  console.log("Verifying webhook signature:");
  console.log("Provided header:", hmacHeader);
  console.log("Generated digest:", digest);

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// ------------------------------------------------------------------
// 2) Mutation to "activate" an inventoryItem at a specific location
// ------------------------------------------------------------------
const TOGGLE_ACTIVATION_MUTATION = `
  mutation inventoryBulkToggleActivation($inventoryItemId: ID!, $locationId: ID!) {
    inventoryBulkToggleActivation(
      inventoryItemId: $inventoryItemId,
      inventoryItemUpdates: [
        {
          locationId: $locationId,
          activate: true
        }
      ]
    ) {
      inventoryItem {
        id
      }
      inventoryLevels {
        id
        location {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function activateInventoryItem(adminHeaders, inventoryItemId, locationId) {
  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({
        query: TOGGLE_ACTIVATION_MUTATION,
        variables: {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
          locationId: `gid://shopify/Location/${locationId}`,
        },
      }),
    }
  );

  const data = await response.json();
  if (data.errors) {
    throw new Error(`Error activating inventory: ${JSON.stringify(data.errors)}`);
  }
  if (data.data?.inventoryBulkToggleActivation?.userErrors?.length) {
    throw new Error(
      `User errors activating inventory: ${JSON.stringify(
        data.data.inventoryBulkToggleActivation.userErrors
      )}`
    );
  }

  return data;
}

// ------------------------------------------------------------------
// 3) Mutation to update inventory using inventorySetQuantities
// ------------------------------------------------------------------
async function setInventoryQuantity(adminHeaders, inventoryItemId, locationId, quantity) {
  // Ensure inventoryItemId is properly formatted
  let cleanInventoryItemId;

  if (typeof inventoryItemId === "string") {
    cleanInventoryItemId = inventoryItemId.startsWith("gid://shopify/InventoryItem/")
      ? inventoryItemId // If it's already formatted, use as is
      : `gid://shopify/InventoryItem/${inventoryItemId}`; // Otherwise, format it correctly
  } else {
    cleanInventoryItemId = `gid://shopify/InventoryItem/${inventoryItemId}`;
  }

  console.log(`🛠 Updating inventory for: ${cleanInventoryItemId} at location: ${locationId} with quantity: ${quantity}`);

  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({
        query: `
          mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              inventoryAdjustmentGroup {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          input: {
            name: "on_hand",
            reason: "correction",
            ignoreCompareQuantity: true,
            referenceDocumentUri: "gid://shopify/Order/123456789",
            quantities: [
              {
                inventoryItemId: cleanInventoryItemId,
                locationId: `gid://shopify/Location/${locationId}`,
                quantity,
              },
            ],
          },
        },
      }),
    }
  );

  const data = await response.json();

  if (data.errors) {
    console.error(`❌ Error updating inventory for ${cleanInventoryItemId}:`, JSON.stringify(data.errors, null, 2));
  } else {
    console.log(`✅ Successfully updated inventory for ${cleanInventoryItemId}`);
  }

  return data;
}



// ------------------------------------------------------------------
// 4) Functions to determine if an item is a master or child
//    using Metafields in the Variant
// ------------------------------------------------------------------

/**
 * Given an inventoryItemId, retrieve the associated variant and:
 *  - Check if it is a MASTER (metafield: "master" = "true").
 *  - If it is not a master, search within the PRODUCT for the variant 
 *    that is a master and contains this variant ID in its `childrenkey` metafield.
 *
 * Returns:
 *   { isChild: true, masterVariantId: "...", masterInventoryItemId: "..." } if it is a child
 *   { isMaster: true, variantId: "...", inventoryItemId: "..." } if it is a master
 *   (or null if nothing is found)
 */
async function getMasterChildInfo(adminHeaders, inventoryItemId) {
  console.log(`🔍 Retrieving information for inventoryItemId: ${inventoryItemId}`);

  // 1️⃣ Retrieve variant information that triggered the webhook
  const query = `
    query getVariantByInventory($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        id
        variant {
          id
          title
          product {
            id
            title
          }
          metafields(first: 250) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({
        query,
        variables: { inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}` },
      }),
    }
  );

  const data = await response.json();
  console.log("📩 Shopify Response:", JSON.stringify(data, null, 2));

  const variantNode = data?.data?.inventoryItem?.variant;
  if (!variantNode) {
    console.log("❌ No variant found for this InventoryItem.");
    return null;
  }

  const metafields = variantNode?.metafields?.edges || [];
  
  // 2️⃣ Check if the variant is a MASTER
  const masterMetafield = metafields.find(m => 
    m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
  );

  const isMaster = masterMetafield?.node?.value?.trim().toLowerCase() === "true";

  if (isMaster) {
    console.log("✅ This variant is a MASTER.");

    // Retrieve the list of children
    const childrenMetafield = metafields.find(m => 
      m.node.namespace === "projektstocksyncchildren" && m.node.key === "childrenkey"
    );

    let childrenIds = [];
    if (childrenMetafield?.node?.value) {
      try {
        childrenIds = JSON.parse(childrenMetafield.node.value);
      } catch (error) {
        console.error("❌ Error parsing JSON from 'childrenkey':", error);
      }
    }

    return {
      isMaster: true,
      variantId: variantNode.id,
      inventoryItemId: inventoryItemId,
      children: childrenIds,
    };
  }

  // 3️⃣ 🔍 Search across all variants of all products (using pagination)
  console.log("🔍 Searching for MASTER within all store variants using pagination...");

  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const allProductsQuery = `
      query getAllVariants($cursor: String) {
        products(first: 50, after: $cursor) {
          edges {
            node {
              id
              title
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    inventoryItem {
                      id
                    }
                    metafields(first: 10) {
                      edges {
                        node {
                          namespace
                          key
                          value
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const allProductsResponse = await fetch(
      "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeaders,
        },
        body: JSON.stringify({ query: allProductsQuery, variables: { cursor } }),
      }
    );

    const allProductsData = await allProductsResponse.json();
    console.log("📩 Shopify Paged Products Response:", JSON.stringify(allProductsData, null, 2));

    const allProducts = allProductsData?.data?.products?.edges || [];
    
    for (const productEdge of allProducts) {
      const product = productEdge.node;
      for (const variantEdge of product.variants.edges) {
        const possibleMaster = variantEdge.node;

        const masterMetafields = possibleMaster?.metafields?.edges || [];
        const masterField = masterMetafields.find(m => 
          m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
        );

        if (masterField?.node?.value?.trim().toLowerCase() === "true") {
          console.log(`✅ Possible MASTER found: ${possibleMaster.id} in product ${product.id}`);

          const childrenKeyField = masterMetafields.find(m => 
            m.node.namespace === "projektstocksyncchildren" && m.node.key === "childrenkey"
          );

          let possibleChildrenIds = [];
          if (childrenKeyField?.node?.value) {
            try {
              possibleChildrenIds = JSON.parse(childrenKeyField.node.value);
            } catch (err) {
              console.error("❌ Error parsing 'childrenkey':", err);
            }
          }

          // If the current variant ID is found in the children list, we have identified its MASTER
          if (possibleChildrenIds.includes(variantNode.id)) {
            console.log(`✅ Confirmed: ${variantNode.id} is a CHILD of ${possibleMaster.id}`);
            return {
              isChild: true,
              masterVariantId: possibleMaster.id,
              masterInventoryItemId: possibleMaster.inventoryItem?.id
                ? possibleMaster.inventoryItem.id.replace("gid://shopify/InventoryItem/", "")
                : null,
            };
          }
        }
      }
    }

    // Update pagination values
    hasNextPage = allProductsData?.data?.products?.pageInfo?.hasNextPage;
    cursor = allProductsData?.data?.products?.pageInfo?.endCursor;
  }

  console.log("❌ No MASTER found for this variant across the store.");
  return null;
}

/**
 * Retrieves the list of *InventoryItem IDs* for all child variants 
 * of a variant that is designated as a MASTER.
 * 
 * 1) Read its metafield "childrenkey" => array of VARIANT IDs
 * 2) Convert each "Variant ID" => its corresponding "InventoryItem ID"
 */
async function getChildrenInventoryItems(adminHeaders, masterVariantId) {
  console.log(`🔍 Fetching children for masterVariantId: ${masterVariantId}`);

  // 1️⃣ Consulta para obtener los children desde metafield y variantes del mismo producto
  const query = `
  query GetProductVariant($variantId: ID!) {
    productVariant(id: $variantId) {
      id
      metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
        value
      }
      product {
        variants(first: 250) {
          edges {
            node {
              id
              inventoryItem {
                id
              }
            }
          }
        }
      }
    }
  }
`;

  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({
        query,
        variables: { variantId: masterVariantId },
      }),
    }
  );

  const data = await response.json();
  console.log("📩 Full response from Shopify:", JSON.stringify(data, null, 2));

  if (data.errors) {
    console.error("❌ Shopify GraphQL Error:", JSON.stringify(data.errors, null, 2));
    return [];
  }

  const variant = data?.data?.productVariant;
  if (!variant) {
    console.error(`❌ Variant not found for masterVariantId: ${masterVariantId}`);
    return [];
  }

  // 2️⃣ Extraer y limpiar los IDs de las variantes hijas
  let childVariantIds = [];
  try {
    if (variant.metafield?.value) {
      childVariantIds = JSON.parse(variant.metafield.value).map((id) =>
        id.replace("gid://shopify/ProductVariant/", "")
      );
    }
  } catch (err) {
    console.error("❌ Error parsing 'childrenkey' from master variant:", err);
    return [];
  }

  if (!Array.isArray(childVariantIds) || childVariantIds.length === 0) {
    console.warn(`⚠️ No children found for masterVariantId: ${masterVariantId}`);
    return [];
  }

  console.log(`📌 Children IDs from metafield (cleaned): ${JSON.stringify(childVariantIds)}`);

  // 3️⃣ Intentar obtener los InventoryItem ID de las variantes del mismo producto
  const allVariantEdges = variant.product?.variants?.edges || [];
  let childInventoryItemIds = childVariantIds.map((childVarId) => {
    const childEdge = allVariantEdges.find((edge) =>
      edge.node.id.replace("gid://shopify/ProductVariant/", "") === childVarId
    );

    if (!childEdge) {
      console.warn(`⚠️ No matching inventory item found for child variant in product query: ${childVarId}`);
      return null;
    }
    return childEdge.node.inventoryItem?.id || null;
  }).filter(Boolean); // Remove null values

  // 4️⃣ Si no encontramos todos los `inventoryItemId`, hacer una consulta individual por cada uno
  const missingVariants = childVariantIds.filter(
    (childVarId) => !childInventoryItemIds.includes(childVarId)
  );

  if (missingVariants.length > 0) {
    console.log(`🔍 Fetching missing variants individually: ${JSON.stringify(missingVariants)}`);

    const variantQuery = `
    query GetVariants($variantIds: [ID!]!) {
      nodes(ids: $variantIds) {
        ... on ProductVariant {
          id
          inventoryItem {
            id
          }
        }
      }
    }`;

    const missingResponse = await fetch(
      "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeaders,
        },
        body: JSON.stringify({
          query: variantQuery,
          variables: { variantIds: missingVariants.map(id => `gid://shopify/ProductVariant/${id}`) },
        }),
      }
    );

    const missingData = await missingResponse.json();
    console.log("📩 Missing Variants Response from Shopify:", JSON.stringify(missingData, null, 2));

    if (!missingData.errors) {
      missingData.data.nodes.forEach((node) => {
        if (node?.inventoryItem?.id) {
          childInventoryItemIds.push(node.inventoryItem.id);
        } else {
          console.warn(`⚠️ Variant ${node?.id} has no inventoryItem.`);
        }
      });
    } else {
      console.error("❌ Error fetching missing variants:", JSON.stringify(missingData.errors, null, 2));
    }
  }

  console.log(`✅ Final list of child InventoryItem IDs: ${JSON.stringify(childInventoryItemIds)}`);

  return childInventoryItemIds;
}




// ------------------------------------------------------------------
// 5) Main Webhook
// ------------------------------------------------------------------
export const action = async ({ request }) => {
  console.log("Received webhook request for inventory update.");

  // 1. Verify HMAC
  const secret = process.env.SHOPIFY_API_SECRET;
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
  const rawBody = await request.text();

  console.log("Webhook raw body:", rawBody);

  const isValid = verifyHmac(rawBody, hmacHeader, secret);
  console.log("HMAC valid:", isValid);

  if (!isValid) {
    console.error("Invalid webhook signature.");
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("Webhook signature verified, proceeding with request.");

  // 2. Parse payload
  const payload = JSON.parse(rawBody);
  console.log("Parsed webhook payload:", payload);

  // 3. Authenticate
  let admin;
  try {
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!token) {
      throw new Error("Access token is missing");
    }

    admin = {
      headers: {
        "X-Shopify-Access-Token": token,
      },
    };
    console.log("Authenticated Shopify admin client for webhook.");
  } catch (error) {
    console.error("Authentication failed:", error);
    return new Response("Authentication failed", { status: 403 });
  }

  // 4. Extract data
  const inventoryItemId = payload.inventory_item_id; // number
  const newQuantity = payload.available;
  const locationId = payload.location_id; // number

  console.log("Formatted Inventory Item ID:", `gid://shopify/InventoryItem/${inventoryItemId}`);
  console.log("Formatted Location ID:", `gid://shopify/Location/${locationId}`);

  // 5. Verify if the item exists at the location (if not, activate it)
  const inventoryCheckQuery = `
    query getInventoryItem($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        id
        inventoryLevels(first: 10) {
          edges {
            node {
              location {
                id
              }
              quantities(names: ["available", "on_hand"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  `;

  try {
    console.log("Checking if inventory item exists/is active in location...");
    const inventoryCheckResponse = await fetch(
      "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...admin.headers,
        },
        body: JSON.stringify({
          query: inventoryCheckQuery,
          variables: {
            inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
          },
        }),
      }
    );

    const inventoryCheckData = await inventoryCheckResponse.json();
    console.log("Full inventory check response:", JSON.stringify(inventoryCheckData, null, 2));

    const itemData = inventoryCheckData?.data?.inventoryItem;
    if (!itemData) {
      console.log("No data => Attempting to activate in that location...");
      await activateInventoryItem(admin.headers, inventoryItemId, locationId);
    } else {
      // Check if it is already active
      const edges = itemData.inventoryLevels.edges;
      const locEdge = edges.find((edge) => edge.node.location.id === `gid://shopify/Location/${locationId}`);
      if (!locEdge) {
        console.log("Item found, but not active in location => activating...");
        await activateInventoryItem(admin.headers, inventoryItemId, locationId);
      } else {
        console.log("Inventory item is already active in location. Proceeding...");
      }
    }
  } catch (err) {
    console.error("Error verifying/activating item in location:", err);
    return new Response("Error verifying location", { status: 500 });
  }

  // 6. Update this inventory item
  console.log(`Updating quantity of ${inventoryItemId} to ${newQuantity}...`);
  try {
    const selfUpdate = await setInventoryQuantity(admin.headers, inventoryItemId, locationId, newQuantity);
    console.log("Self item update response =>", JSON.stringify(selfUpdate, null, 2));
  } catch (err) {
    console.error("Error updating inventory from webhook:", err);
    return json({ error: err.message }, { status: 400 });
  }

  // 7. MASTER-CHILD Logic (bidirectional sync)
  console.log("Determining if item is child or master...");
  try {
    const info = await getMasterChildInfo(admin.headers, inventoryItemId);

    if (!info) {
      // No master or child relationship found => no further updates required
      console.log("No master-child info found => done.");
      return json({ message: "No master/child relationship. Update done." });
    }

    if (info.isChild) {
      // => Item is a CHILD. Update its MASTER and then all children
      console.log(`🔄 Item ${inventoryItemId} is a CHILD. Syncing with MASTER ${info.masterInventoryItemId}`);
    
      if (!info.masterInventoryItemId) {
        console.warn("⚠️ Master inventoryItemId not found. Skipping update.");
        return json({ message: "Child updated, but no master ID found." });
      }
    
      // 1️⃣ Update the MASTER with the new quantity
      console.log(`🔄 Updating MASTER ${info.masterInventoryItemId} with quantity ${newQuantity}`);
      try {
        const masterUpdate = await setInventoryQuantity(
          admin.headers,
          info.masterInventoryItemId,
          locationId,
          newQuantity
        );
        console.log("✅ Master update response:", JSON.stringify(masterUpdate, null, 2));
      } catch (err) {
        console.error("❌ Error updating MASTER inventory:", err);
        return json({ error: "Failed to update master inventory" }, { status: 500 });
      }
    
      // 2️⃣ Retrieve MASTER's children and update them
      console.log("🔍 Fetching children (siblings) from MASTER...");
      let siblings = [];
      try {
        siblings = await getChildrenInventoryItems(admin.headers, info.masterVariantId);
        console.log("📌 Siblings found:", siblings);
      } catch (err) {
        console.error("❌ Error fetching siblings:", err);
        return json({ error: "Failed to retrieve sibling inventory" }, { status: 500 });
      }
    
      for (const childInventoryId of siblings) {
        if (Number(childInventoryId) === Number(inventoryItemId)) {
          console.log("⏭️ Skipping update for the same child:", childInventoryId);
          continue;
        }
    
        console.log(`🔄 Updating sibling ${childInventoryId} with quantity ${newQuantity}`);
        try {
          const siblingUpdate = await setInventoryQuantity(
            admin.headers,
            childInventoryId,
            locationId,
            newQuantity
          );
          console.log("✅ Sibling update response:", JSON.stringify(siblingUpdate, null, 2));
        } catch (err) {
          console.error(`❌ Error updating sibling ${childInventoryId}:`, err);
        }
      }
    } else if (info.isMaster) {
      // => Item is a MASTER. Update all its children
      console.log(`🔄 Item ${inventoryItemId} is a MASTER. Syncing all children...`);
    
      if (!info.variantId) {
        console.warn("⚠️ Master Variant ID not found. Skipping child updates.");
        return json({ message: "Master update skipped due to missing variant ID." });
      }
    
      // Retrieve MASTER's children and update them
      let childInvIds = [];
      try {
        childInvIds = await getChildrenInventoryItems(admin.headers, info.variantId);
        console.log("📌 Children to update:", childInvIds);
      } catch (err) {
        console.error("❌ Error fetching children:", err);
        return json({ error: "Failed to retrieve children inventory" }, { status: 500 });
      }
    
      for (const childId of childInvIds) {
        console.log(`🔄 Updating child ${childId} with quantity ${newQuantity}`);
        try {
          const update = await setInventoryQuantity(
            admin.headers,
            childId,
            locationId,
            newQuantity
          );
          console.log("✅ Child update response:", JSON.stringify(update, null, 2));
        } catch (err) {
          console.error(`❌ Error updating child ${childId}:`, err);
        }
      }
    }
    

    return json({ message: "Inventory updated (master-child sync complete)." });
  } catch (err) {
    console.error("Error in master-child sync logic:", err);
    return json({ error: err.message }, { status: 500 });
  }
};

