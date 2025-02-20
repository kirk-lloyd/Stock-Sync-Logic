import { json } from "@remix-run/node";
import crypto from "crypto";

/**
 * ------------------------------------------------------------------
 * PROFESSIONAL AUSTRALIAN ENGLISH COMMENTS
 * This code listens for Shopify Inventory Level Update Webhooks.
 * 
 * We store each variant's "old" stock in a metafield:
 *   namespace: "projektstocksyncqtyold"
 *   key: "qtyold"
 *   type: "number_integer"
 *
 * Steps:
 *  1) Retrieve the old quantity from 'qtyold' metafield.
 *  2) Compare with new quantity from the webhook.
 *  3) If it's CHILD => do difference-based approach:
 *        newMasterQty = masterOldQty + (childDiff * childDivisor)
 *  4) If it's MASTER => recalc children => floor(MASTER / childDivisor)
 *  5) Update each changed variant's 'qtyold' using 'metafieldsSet'.
 *  6) Concurrency locks, dedup, and predicted updates remain to
 *     prevent infinite loops or collisions.
 * ------------------------------------------------------------------
 */

/*
 * ------------------------------------------------------------------
 * 0) SHORT-TERM DEDUPLICATION (10s FOR EXACT PAYLOAD)
 * ------------------------------------------------------------------
 */
const recentlyProcessedExact = new Map();

function markExactKey(key) {
  recentlyProcessedExact.set(key, Date.now());
  setTimeout(() => {
    recentlyProcessedExact.delete(key);
  }, 10000);
}

function hasExactKey(key) {
  return recentlyProcessedExact.has(key);
}

function buildExactDedupKey(payload) {
  const { inventory_item_id, location_id, available, updated_at } = payload;
  return `${inventory_item_id}-${location_id}-${available}-${updated_at}`;
}

/*
 * ------------------------------------------------------------------
 * 0.1) 6-SECOND LOCK FOR (INVENTORY_ITEM + LOCATION)
 * ------------------------------------------------------------------
 */
const recentlyTouched = new Map();

function markComboKey(key) {
  recentlyTouched.set(key, Date.now());
  setTimeout(() => {
    recentlyTouched.delete(key);
  }, 6000);
}

function hasComboKey(key) {
  return recentlyTouched.has(key);
}

/*
 * ------------------------------------------------------------------
 * 0.2) PREDICTED (FUTURE) UPDATES MAP
 * ------------------------------------------------------------------
 * We use this to skip any known, intentional updates (our own),
 * thus preventing repeated loops from Shopify webhooks.
 * ------------------------------------------------------------------
 */
const predictedUpdates = new Map();

function buildPredictedKey(inventoryItemId, locationId, newQty) {
  return `${inventoryItemId}-${locationId}-${newQty}`;
}

function markPredictedUpdate(pKey) {
  predictedUpdates.set(pKey, Date.now());
  setTimeout(() => {
    predictedUpdates.delete(pKey);
  }, 10000);
}

function hasPredictedUpdate(pKey) {
  return predictedUpdates.has(pKey);
}

/*
 * ------------------------------------------------------------------
 * 1) HMAC VERIFICATION
 * ------------------------------------------------------------------
 */
function verifyHmac(body, hmacHeader, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

/*
 * ------------------------------------------------------------------
 * 2) ACTIVATE AN INVENTORY ITEM IN A LOCATION (IF NOT ACTIVE)
 * ------------------------------------------------------------------
 */
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
        ...adminHeaders,
        "Content-Type": "application/json",
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
    throw new Error(`Error activating inventory => ${JSON.stringify(data.errors)}`);
  }
  if (data.data?.inventoryBulkToggleActivation?.userErrors?.length) {
    throw new Error(
      `User errors => ${JSON.stringify(data.data.inventoryBulkToggleActivation.userErrors)}`
    );
  }
  return data;
}

/*
 * ------------------------------------------------------------------
 * 3) MUTATION => CHANGE INVENTORY QUANTITY
 * ------------------------------------------------------------------
 */
async function setInventoryQuantity(adminHeaders, inventoryItemId, locationId, quantity, internal = false) {
  // normalise the ID
  let cleanInventoryItemId;
  if (typeof inventoryItemId === "string") {
    if (inventoryItemId.startsWith("gid://shopify/InventoryItem/")) {
      cleanInventoryItemId = inventoryItemId;
    } else {
      cleanInventoryItemId = `gid://shopify/InventoryItem/${inventoryItemId}`;
    }
  } else {
    cleanInventoryItemId = `gid://shopify/InventoryItem/${inventoryItemId}`;
  }

  const referenceDocumentUriValue = internal
    ? "https://example-app-url.ngrok-free.app/by_app/internal-update"
    : "https://example-app-url.ngrok-free.app/external-update";

  const actionId = `${cleanInventoryItemId}-${locationId}`;
  console.log(
    `🔧 setInventoryQuantity => (Action ID: ${actionId}), item: ${cleanInventoryItemId}, location: ${locationId}, qty: ${quantity}, internal: ${internal}`
  );

  // Mark as predicted to avoid loop
  const predictedKey = buildPredictedKey(
    cleanInventoryItemId.replace("gid://shopify/InventoryItem/", ""),
    locationId,
    quantity
  );
  markPredictedUpdate(predictedKey);

  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
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
            referenceDocumentUri: referenceDocumentUriValue,
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
    console.error(`❌ setInventoryQuantity => error for ${cleanInventoryItemId}:`, data.errors);
  } else {
    console.log(`✅ Inventory updated => ${cleanInventoryItemId}`);
  }
  return data;
}

/*
 * ------------------------------------------------------------------
 * 3.1) GET/SET QTYOLD METAFIELD
 * ------------------------------------------------------------------
 * Using 'metafieldsSet' with the 'metafields' argument,
 * not 'input' or 'metafieldUpsert'.
 */

/**
 * Get the old quantity from the "qtyold" metafield, or 0 if it doesn't exist.
 */
async function getQtyOldValue(adminHeaders, variantId) {
  const query = `
    query GetQtyOld($id: ID!) {
      productVariant(id: $id) {
        metafield(namespace: "projektstocksyncqtyold", key: "qtyold") {
          value
        }
      }
    }
  `;
  const variables = { id: variantId };
  const resp = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await resp.json();
  const valStr = data?.data?.productVariant?.metafield?.value;
  if (!valStr) {
    return 0;
  }
  return parseInt(valStr, 10) || 0;
}

/**
 * Set the "qtyold" metafield to a new integer value using the 'metafieldsSet' mutation.
 * This requires a "metafields" array, each with { ownerId, key, namespace, type, value }.
 */
async function setQtyOldValue(adminHeaders, variantId, newQty) {
  // Build the GraphQL mutation
  const mutation = `#graphql
    mutation metafieldsSetVariant($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          value
          ownerType
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // Prepare the array of one metafield
  const variables = {
    metafields: [
      {
        ownerId: variantId, // e.g. "gid://shopify/ProductVariant/12345"
        namespace: "projektstocksyncqtyold",
        key: "qtyold",
        type: "number_integer",
        value: String(newQty),
      },
    ],
  };

  // Execute the request
  const resp = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: mutation, variables }),
    }
  );

  const data = await resp.json();
  if (data.errors) {
    console.error("❌ setQtyOldValue => GraphQL errors:", data.errors);
  } else if (data.data?.metafieldsSet?.userErrors?.length) {
    console.error("❌ setQtyOldValue => userErrors:", data.data.metafieldsSet.userErrors);
  } else {
    console.log(
      `✅ Updated 'qtyold' => new value: ${newQty} for variant: ${variantId}`
    );
  }
  return data;
}

/*
 * ------------------------------------------------------------------
 * 4) DETERMINE IF THIS ITEM IS MASTER OR CHILD
 * ------------------------------------------------------------------
 */
async function getMasterChildInfo(adminHeaders, inventoryItemId) {
  console.log(`🔍 getMasterChildInfo => checking itemId ${inventoryItemId}`);

  // (1) get the variant for this InventoryItem
  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
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
        `,
        variables: {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
        },
      }),
    }
  );

  const data = await response.json();
  const variantNode = data?.data?.inventoryItem?.variant;
  if (!variantNode) {
    console.log("❌ No variant => no MASTER/CHILD relationship found.");
    return null;
  }

  // Check if MASTER
  const metafields = variantNode.metafields?.edges || [];
  const masterField = metafields.find(
    (m) => m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
  );
  const isMaster = masterField?.node?.value?.trim().toLowerCase() === "true";
  if (isMaster) {
    console.log("✅ This variant is a MASTER.");
    const childrenField = metafields.find(
      (m) => m.node.namespace === "projektstocksyncchildren" && m.node.key === "childrenkey"
    );
    let childrenIds = [];
    if (childrenField?.node?.value) {
      try {
        childrenIds = JSON.parse(childrenField.node.value);
      } catch (err) {
        console.error("❌ Error parsing childrenkey =>", err);
      }
    }
    return {
      isMaster: true,
      variantId: variantNode.id, // e.g. "gid://shopify/ProductVariant/12345"
      inventoryItemId,
      children: childrenIds,
    };
  }

  // If not MASTER => see if it's a CHILD by searching storewide for references
  console.log("🔍 Searching storewide for a MASTER referencing this item as CHILD...");
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const allProductsQuery = `
      query getAllVariants($cursor: String) {
        products(first: 50, after: $cursor) {
          edges {
            node {
              id
              variants(first: 50) {
                edges {
                  node {
                    id
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
    const allProdsResp = await fetch(
      "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
      {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: allProductsQuery, variables: { cursor } }),
      }
    );

    const allProdsData = await allProdsResp.json();
    const allProducts = allProdsData?.data?.products?.edges || [];

    for (const productEdge of allProducts) {
      for (const variantEdge of productEdge.node.variants.edges) {
        const possibleMaster = variantEdge.node;
        const pmfs = possibleMaster.metafields?.edges || [];
        const masterFlag = pmfs.find(
          (m) => m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
        );
        const isMasterVariant = masterFlag?.node?.value?.trim().toLowerCase() === "true";
        if (!isMasterVariant) continue;

        const childrenKeyField = pmfs.find(
          (m) => m.node.namespace === "projektstocksyncchildren" && m.node.key === "childrenkey"
        );
        let possibleChildren = [];
        if (childrenKeyField?.node?.value) {
          try {
            possibleChildren = JSON.parse(childrenKeyField.node.value);
          } catch (err) {
            console.error("❌ parse error =>", err);
          }
        }

        if (possibleChildren.includes(variantNode.id)) {
          console.log(`✅ Found CHILD => MASTER:${possibleMaster.id}, CHILD:${variantNode.id}`);
          return {
            isChild: true,
            childVariantId: variantNode.id,
            masterVariantId: possibleMaster.id,
            masterInventoryItemId: possibleMaster.inventoryItem?.id
              ? possibleMaster.inventoryItem.id.replace("gid://shopify/InventoryItem/", "")
              : null,
            inventoryItemId,
          };
        }
      }
    }

    hasNextPage = allProdsData.data?.products?.pageInfo?.hasNextPage;
    cursor = allProdsData.data?.products?.pageInfo?.endCursor;
  }

  console.log("❌ No MASTER referencing this => not a CHILD either.");
  return null;
}

/*
 * ------------------------------------------------------------------
 * 4.1) GET THE "qtymanagement" FOR A VARIANT (CHILD OR SIBLING)
 * ------------------------------------------------------------------
 */
async function getVariantQtyManagement(adminHeaders, variantId) {
  const query = `
    query GetVariantQtyManagement($variantId: ID!) {
      productVariant(id: $variantId) {
        metafield(namespace: "projektstocksyncqtymanagement", key: "qtymanagement") {
          value
        }
      }
    }
  `;
  const resp = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { variantId } }),
    }
  );
  const data = await resp.json();
  const strVal = data?.data?.productVariant?.metafield?.value;
  return strVal ? parseInt(strVal, 10) : 1;
}

/*
 * ------------------------------------------------------------------
 * 4.2) GET CHILDREN (inventoryItemId) OF A MASTER
 * ------------------------------------------------------------------
 */
async function getChildrenInventoryItems(adminHeaders, masterVariantId) {
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
  const resp = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { variantId: masterVariantId } }),
    }
  );

  const data = await resp.json();
  if (data.errors) {
    console.error(
      `❌ getChildrenInventoryItems => error retrieving children for MASTER:${masterVariantId}`,
      data.errors
    );
    return [];
  }

  const variant = data?.data?.productVariant;
  if (!variant) {
    console.error(`❌ MASTER variant not found => ${masterVariantId}`);
    return [];
  }

  let childIds = [];
  try {
    if (variant.metafield?.value) {
      childIds = JSON.parse(variant.metafield.value);
    }
  } catch (err) {
    console.error("❌ childrenkey parse error =>", err);
    return [];
  }

  const normChildIds = childIds.map((id) =>
    id.startsWith("gid://shopify/ProductVariant/")
      ? id.replace("gid://shopify/ProductVariant/", "")
      : id
  );

  const allVariantEdges = variant.product?.variants?.edges || [];
  let childrenVariants = normChildIds
    .map((cid) => {
      const childEdge = allVariantEdges.find(
        (e) => e.node.id.replace("gid://shopify/ProductVariant/", "") === cid
      );
      if (!childEdge) {
        console.warn(`⚠️ Child variant not found in product => ${cid}`);
        return null;
      }
      return {
        variantId: childEdge.node.id,
        inventoryItemId: childEdge.node.inventoryItem?.id,
      };
    })
    .filter(Boolean);

  // if some are missing, we attempt a direct query
  const foundIds = childrenVariants.map((c) =>
    c.variantId.replace("gid://shopify/ProductVariant/", "")
  );
  const missingIds = normChildIds.filter((id) => !foundIds.includes(id));
  if (missingIds.length > 0) {
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
      }
    `;
    const missingResp = await fetch(
      "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
      {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: variantQuery,
          variables: {
            variantIds: missingIds.map((id) => `gid://shopify/ProductVariant/${id}`),
          },
        }),
      }
    );
    const missingData = await missingResp.json();
    if (!missingData.errors) {
      for (const node of missingData.data.nodes) {
        if (node?.inventoryItem?.id) {
          childrenVariants.push({
            variantId: node.id,
            inventoryItemId: node.inventoryItem.id,
          });
        } else {
          console.warn(`⚠️ Missing inventoryItem for => ${node?.id}`);
        }
      }
    } else {
      console.error("❌ getChildrenInventoryItems => missing variant fetch error:", missingData.errors);
    }
  }

  console.log("✅ Final children => MASTER:", JSON.stringify(childrenVariants, null, 2));
  return childrenVariants;
}

/*
 * ------------------------------------------------------------------
 * 5) CONCURRENCY LOCK
 * ------------------------------------------------------------------
 */
const updateLocks = new Map();

async function processWithDeferred(key, initialUpdate, processUpdate) {
  if (updateLocks.has(key)) {
    const lock = updateLocks.get(key);
    lock.pending = initialUpdate;
    console.log(`Lock active => deferring new update for key ${key}`);
    return;
  }
  updateLocks.set(key, { pending: null });

  let currentUpdate = initialUpdate;
  try {
    do {
      console.log(`Processing => key:${key}, update:`, currentUpdate);
      await processUpdate(currentUpdate);
      const lock = updateLocks.get(key);
      currentUpdate = lock.pending;
      lock.pending = null;
    } while (currentUpdate !== null);
  } finally {
    updateLocks.delete(key);
    console.log(`Lock released => key:${key}`);
  }
}

/*
 * ------------------------------------------------------------------
 * 6) HELPER => GET CURRENT "available" QTY
 * ------------------------------------------------------------------
 */
async function getCurrentAvailableQuantity(adminHeaders, inventoryItemId, locationId) {
  async function doQuery(itemId, locId) {
    const query = `
      query getInventoryLevels($inventoryItemId: ID!) {
        inventoryItem(id: $inventoryItemId) {
          id
          inventoryLevels(first: 50) {
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
    const response = await fetch(
      "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
      {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { inventoryItemId: itemId },
        }),
      }
    );

    const data = await response.json();
    const item = data?.data?.inventoryItem;
    if (!item) {
      return null; // might need activation
    }
    const edges = item.inventoryLevels?.edges || [];
    const match = edges.find((e) => e.node.location.id === `gid://shopify/Location/${locId}`);
    if (!match) {
      return null;
    }
    const quantityEntry = match.node.quantities.find((q) => q.name === "available");
    if (!quantityEntry) {
      return 0;
    }
    return quantityEntry.quantity;
  }

  let finalId;
  if (typeof inventoryItemId === "string") {
    if (inventoryItemId.startsWith("gid://shopify/InventoryItem/")) {
      finalId = inventoryItemId;
    } else {
      finalId = `gid://shopify/InventoryItem/${inventoryItemId}`;
    }
  } else {
    finalId = `gid://shopify/InventoryItem/${inventoryItemId}`;
  }

  let qty = await doQuery(finalId, locationId);
  if (qty !== null) return qty;

  console.log(`⚠️ Not found => activating item => ${finalId}, loc:${locationId}`);
  const numericId = finalId.replace("gid://shopify/InventoryItem/", "");
  try {
    await activateInventoryItem(adminHeaders, numericId, locationId);
  } catch (err) {
    console.warn(`⚠️ Activation failed => ${err.message} => returning 0`);
    return 0;
  }

  // re-query once
  qty = await doQuery(finalId, locationId);
  if (qty === null) {
    console.warn(`⚠️ After activation => still not found => returning 0 => item:${finalId}, loc:${locationId}`);
    return 0;
  }
  return qty;
}

/*
 * ------------------------------------------------------------------
 * HELPER => GET INVENTORY ITEM ID FROM A VARIANT ID
 * ------------------------------------------------------------------
 */
async function getInventoryItemIdFromVariantId(adminHeaders, variantId) {
  const query = `
    query GetVariantItem($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryItem {
          id
        }
      }
    }
  `;
  const variables = { id: variantId };

  const resp = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await resp.json();
  const itemId = data?.data?.productVariant?.inventoryItem?.id;
  if (!itemId) {
    console.warn(`No inventoryItem found => variantId: ${variantId}`);
    return null;
  }
  return itemId.replace("gid://shopify/InventoryItem/", "");
}

/*
 * ------------------------------------------------------------------
 * 7) MAIN WEBHOOK HANDLER
 * ------------------------------------------------------------------
 */
export const action = async ({ request }) => {
  console.log("🔔 Inventory Webhook => difference-based with qtyold, using metafieldsSet.");

  // 1) parse the raw body
  const rawBody = await request.text();
  const payload = JSON.parse(rawBody);
  console.log("Webhook payload:", payload);

  // 2) verify HMAC
  const secret = process.env.SHOPIFY_API_SECRET;
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
  if (!secret || !hmacHeader) {
    console.error("Missing secret or HMAC => aborting.");
    return new Response("Unauthorized", { status: 401 });
  }
  const isValid = verifyHmac(rawBody, hmacHeader, secret);
  if (!isValid) {
    console.error("Invalid HMAC => not from Shopify => aborting.");
    return new Response("Unauthorized", { status: 401 });
  }
  console.log("✅ HMAC verified successfully.");

  // 3) short-term dedup
  const dedupKeyExact = buildExactDedupKey(payload);
  if (hasExactKey(dedupKeyExact)) {
    console.log(`Skipping repeated event => ${dedupKeyExact}`);
    return new Response("Duplicate skip", { status: 200 });
  }
  markExactKey(dedupKeyExact);

  // 4) predicted updates => skip
  const pKey = buildPredictedKey(payload.inventory_item_id, payload.location_id, payload.available);
  if (hasPredictedUpdate(pKey)) {
    console.log(`Skipping => predicted future update => ${pKey}`);
    return new Response("Skipped => predicted future update", { status: 200 });
  }

  // 5) 6-second combo lock => item + location
  const shortComboKey = `${payload.inventory_item_id}-${payload.location_id}`;
  if (hasComboKey(shortComboKey)) {
    console.log(`Skipping => combo locked => ${shortComboKey}`);
    return new Response("Skipped => 6s combo lock", { status: 200 });
  }
  markComboKey(shortComboKey);

  // 6) admin auth
  let adminHeaders;
  try {
    // Assume you have a function to get your Admin token:
    // e.g. const { admin } = await authenticate.admin(request);
    // then admin.graphql(...) or admin.fetch(...) etc.
    // If you already have the token in process.env, do:
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!token) {
      throw new Error("Missing SHOPIFY_ACCESS_TOKEN");
    }
    adminHeaders = { "X-Shopify-Access-Token": token };
    console.log("Admin client auth => success.");
  } catch (err) {
    console.error("Auth error =>", err);
    return new Response("Authentication failed", { status: 403 });
  }

  // 7) Basic payload extraction
  const locationId = payload.location_id;
  const inventoryItemId = payload.inventory_item_id;
  const newQty = payload.available; // new quantity from the webhook
  console.log(`Received => item:${inventoryItemId}, loc:${locationId}, newQty:${newQty}`);

  // 8) Identify if MASTER or CHILD
  const info = await getMasterChildInfo(adminHeaders, inventoryItemId);
  if (!info) {
    console.log("No MASTER/CHILD => we simply update the item and store its new qty in 'qtyold'.");
    await setInventoryQuantity(adminHeaders, inventoryItemId, locationId, newQty);
    // We can't store 'qtyold' if we don't have a variant ID, so exit.
    return new Response("Updated item => no Master/Child relationship", { status: 200 });
  }

  // concurrency
  await processWithDeferred(
    shortComboKey,
    { newQty, locationId, info, adminHeaders },
    async (update) => {
      const { newQty, locationId, info, adminHeaders } = update;

      // We'll fetch the variant ID (CHILD or MASTER) to read/write qtyold
      let triggerVariantId = info.isMaster ? info.variantId : info.childVariantId;
      if (!triggerVariantId) {
        console.warn("No variantId => cannot do difference-based logic, skipping...");
        return;
      }

      // read oldQty from 'qtyold' metafield
      const oldQty = await getQtyOldValue(adminHeaders, triggerVariantId);
      console.log(`(Metafield) oldQty => ${oldQty}, newQty => ${newQty}`);

      // =============== CHILD LOGIC ===============
      if (info.isChild) {
        console.log("CHILD => difference-based => MASTER changes by (childDiff * childDivisor).");

        // difference in child
        const childDiff = newQty - oldQty; 
        console.log(`childDiff => ${childDiff} (new:${newQty}, old:${oldQty})`);

        // childDivisor
        const childDivisor = await getVariantQtyManagement(adminHeaders, info.childVariantId);
        console.log(`childDivisor => ${childDivisor}`);

        // fetch MASTER's old
        const masterOldQty = await getCurrentAvailableQuantity(adminHeaders, info.masterInventoryItemId, locationId);
        console.log(`masterOldQty => ${masterOldQty}`);

        // new MASTER
        const scaledDiff = childDiff * childDivisor;
        const newMasterQty = masterOldQty + scaledDiff;
        console.log(`newMasterQty => ${newMasterQty}`);

        // update the child in Shopify
        await setInventoryQuantity(adminHeaders, info.inventoryItemId, locationId, newQty);

        // if MASTER changes
        if (newMasterQty !== masterOldQty) {
          await setInventoryQuantity(adminHeaders, info.masterInventoryItemId, locationId, newMasterQty, true);
        }

        // recalc siblings
        const siblings = await getChildrenInventoryItems(adminHeaders, info.masterVariantId);
        const finalMasterQty = await getCurrentAvailableQuantity(adminHeaders, info.masterInventoryItemId, locationId);
        console.log(`Siblings => finalMaster => ${finalMasterQty}`);

        // track which variants we changed, so we can set their qtyold
        const updatedVariants = new Set();
        // definitely the CHILD we triggered
        updatedVariants.add(info.childVariantId);
        // if MASTER changed
        if (newMasterQty !== masterOldQty) {
          updatedVariants.add(info.masterVariantId);
        }

        // now siblings
        for (const s of siblings) {
          const sid = s.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
          if (sid === String(info.inventoryItemId)) {
            console.log("Skipping triggering child in sibling loop.");
            continue;
          }
          const sDivisor = await getVariantQtyManagement(adminHeaders, s.variantId);
          const oldSQty = await getCurrentAvailableQuantity(adminHeaders, sid, locationId);
          const newSQty = Math.floor(finalMasterQty / (sDivisor || 1));
          if (newSQty !== oldSQty) {
            console.log(`Updating sibling => old:${oldSQty}, new:${newSQty}`);
            await setInventoryQuantity(adminHeaders, sid, locationId, newSQty, true);
            updatedVariants.add(s.variantId);
          }
          markComboKey(`${sid}-${locationId}`);
        }

        // update qtyold for each updated variant
        for (const vId of updatedVariants) {
          let newVal;
          if (vId === info.childVariantId) {
            // the triggered child
            newVal = newQty;
          } else if (vId === info.masterVariantId) {
            newVal = newMasterQty;
          } else {
            // sibling => fetch from Shopify again
            const siblingItemId = await getInventoryItemIdFromVariantId(adminHeaders, vId);
            if (!siblingItemId) continue;
            const realSQty = await getCurrentAvailableQuantity(adminHeaders, siblingItemId, locationId);
            newVal = realSQty;
          }
          await setQtyOldValue(adminHeaders, vId, newVal);
        }
      }
      // =============== MASTER LOGIC ===============
      else if (info.isMaster) {
        console.log("MASTER => recalc children => floor(MASTER / childDivisor).");
        const oldMasterQty = await getQtyOldValue(adminHeaders, info.variantId);
        console.log(`Master => oldQty:${oldMasterQty}, new:${newQty}`);

        // forcibly set MASTER if changed
        const shopMaster = await getCurrentAvailableQuantity(adminHeaders, info.inventoryItemId, locationId);
        if (shopMaster !== newQty) {
          console.log(`Updating MASTER from ${shopMaster} => ${newQty}`);
          await setInventoryQuantity(adminHeaders, info.inventoryItemId, locationId, newQty);
        }

        // recalc children => floor(MASTER / childDivisor)
        const children = await getChildrenInventoryItems(adminHeaders, info.variantId);
        const updatedVariants = new Set();
        // definitely the MASTER
        updatedVariants.add(info.variantId);

        for (const c of children) {
          const cid = c.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
          const dv = await getVariantQtyManagement(adminHeaders, c.variantId);
          const oldCQty = await getCurrentAvailableQuantity(adminHeaders, cid, locationId);
          const newCQty = Math.floor(newQty / (dv || 1));
          if (newCQty !== oldCQty) {
            console.log(`Child => old:${oldCQty}, new:${newCQty}, divisor:${dv}`);
            await setInventoryQuantity(adminHeaders, cid, locationId, newCQty, true);
            updatedVariants.add(c.variantId);
          }
          markComboKey(`${cid}-${locationId}`);
        }

        // update 'qtyold' for MASTER and changed children
        for (const vId of updatedVariants) {
          if (vId === info.variantId) {
            // MASTER => newQty
            await setQtyOldValue(adminHeaders, vId, newQty);
          } else {
            const childItemId = await getInventoryItemIdFromVariantId(adminHeaders, vId);
            if (!childItemId) continue;
            const realCQty = await getCurrentAvailableQuantity(adminHeaders, childItemId, locationId);
            await setQtyOldValue(adminHeaders, vId, realCQty);
          }
        }
      }

      // done
      markComboKey(`${info.inventoryItemId}-${locationId}`);
    }
  );

  return json({
    message: "Difference-based logic with 'qtyold' using 'metafieldsSet' completed.",
  });
};
