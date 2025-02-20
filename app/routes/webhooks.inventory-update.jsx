import { json } from "@remix-run/node";
import crypto from "crypto";
import prisma from "../db.server.js"; // Adjust the import path based on your project structure

/**
 * ------------------------------------------------------------------
 * PROFESSIONAL AUSTRALIAN ENGLISH COMMENTS
 *
 * This code listens for Shopify Inventory Level webhooks and implements:
 *
 * 1) A short "listening window" aggregator (5s). Any near-simultaneous
 *    updates for the same MASTER combo get batched, preventing collisions.
 *
 * 2) "qtyold" metafield logic for difference-based updates. For CHILD changes,
 *    we do newMaster = (masterOldQty + (childDiff * childDivisor)).
 *
 * 3) childDivisor=1 logic. If a child's qtymanagement = 1, the CHILD's
 *    quantity always matches the MASTER exactly, rather than dividing
 *    or rounding.
 *
 * 4) A fallback query in getChildrenInventoryItems(...) to handle missing
 *    CHILD variants that might not be in the same product as the MASTER.
 *
 * 5) Standard concurrency locks, dedup checks, and predicted update logic
 *    to avoid infinite loops or repeated partial processing.
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
 * UTILITY: RETRIEVE ADMIN HEADERS AND GRAPHQL URL FOR A GIVEN SHOP
 * ------------------------------------------------------------------
 */
async function getShopSessionHeaders(shopDomain) {
  // Look up the session in your database
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain },
  });
  if (!session || !session.accessToken) {
    throw new Error(`No session or accessToken found for shop: ${shopDomain}`);
  }

  // Return the token assigned to that specific shop
  return {
    adminHeaders: {
      "X-Shopify-Access-Token": session.accessToken,
    },
    adminApiUrl: `https://${shopDomain}/admin/api/2024-10/graphql.json`,
  };
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

async function activateInventoryItem(shopDomain, adminHeaders, inventoryItemId, locationId) {
  const response = await fetch(
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
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
async function setInventoryQuantity(
  shopDomain,
  adminHeaders,
  inventoryItemId,
  locationId,
  quantity,
  internal = false
) {
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

  // Custom reference for app-based updates (optional)
  const MY_APP_URL = process.env.MY_APP_URL || "https://your-app-url.com";
  const referenceDocumentUriValue = internal
    ? `${MY_APP_URL}/by_app/internal-update`
    : `${MY_APP_URL}/by_app/external-update`;

  // Mark a "predicted" update to avoid loops
  const pKey = buildPredictedKey(
    cleanInventoryItemId.replace("gid://shopify/InventoryItem/", ""),
    locationId,
    quantity
  );
  markPredictedUpdate(pKey);

  console.log(
    `🔧 setInventoryQuantity => item:${cleanInventoryItemId}, loc:${locationId}, qty:${quantity}, internal:${internal}`
  );

  const response = await fetch(
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
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
    console.error("❌ setInventoryQuantity =>", data.errors);
  } else {
    console.log(`✅ Inventory updated => ${cleanInventoryItemId} => ${quantity}`);
  }
  return data;
}

/*
 * ------------------------------------------------------------------
 * 3.1) GET/SET QTYOLD METAFIELD
 * ------------------------------------------------------------------
 */
async function getQtyOldValue(shopDomain, adminHeaders, variantId) {
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
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
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

async function setQtyOldValue(shopDomain, adminHeaders, variantId, newQty) {
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
  const variables = {
    metafields: [
      {
        ownerId: variantId,
        namespace: "projektstocksyncqtyold",
        key: "qtyold",
        type: "number_integer",
        value: String(newQty),
      },
    ],
  };

  const resp = await fetch(
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
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
    console.log(`✅ Updated 'qtyold' => new value: ${newQty} for variant: ${variantId}`);
  }
  return data;
}

/*
 * ------------------------------------------------------------------
 * 4) DETERMINE IF THIS ITEM IS MASTER OR CHILD
 * ------------------------------------------------------------------
 */
async function getMasterChildInfo(shopDomain, adminHeaders, inventoryItemId) {
  console.log(`🔍 getMasterChildInfo => inventory item: ${inventoryItemId}`);

  // 1) Find the variant associated with this inventory item
  const response = await fetch(
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
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
    console.log("❌ No variant was found; no MASTER/CHILD relationship detected.");
    return null;
  }

  const metafields = variantNode.metafields?.edges || [];
  const masterField = metafields.find(
    (m) => m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
  );
  const isMaster = masterField?.node?.value?.trim().toLowerCase() === "true";

  if (isMaster) {
    console.log("✅ This variant is designated as MASTER.");
    const childrenKey = metafields.find(
      (m) => m.node.namespace === "projektstocksyncchildren" && m.node.key === "childrenkey"
    );
    let childrenIds = [];
    if (childrenKey?.node?.value) {
      try {
        childrenIds = JSON.parse(childrenKey.node.value);
      } catch (err) {
        console.error("❌ Error parsing 'childrenkey' =>", err);
      }
    }
    return {
      isMaster: true,
      variantId: variantNode.id,
      inventoryItemId,
      children: childrenIds,
    };
  }

  // If not MASTER, check if it's a CHILD
  console.log("🔎 Searching the store for a MASTER referencing this item as a CHILD...");
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const allProdsQuery = `
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
    const resp = await fetch(
      `https://${shopDomain}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: allProdsQuery, variables: { cursor } }),
      }
    );
    const allData = await resp.json();
    const allProducts = allData?.data?.products?.edges || [];

    for (const pEdge of allProducts) {
      for (const vEdge of pEdge.node.variants.edges) {
        const possibleMaster = vEdge.node;
        const pmfs = possibleMaster.metafields?.edges || [];
        const masterFlag = pmfs.find(
          (m) => m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
        );
        const isMasterVariant =
          masterFlag?.node?.value?.trim().toLowerCase() === "true";
        if (!isMasterVariant) continue;

        const childrenKey = pmfs.find(
          (m) =>
            m.node.namespace === "projektstocksyncchildren" && m.node.key === "childrenkey"
        );
        let childArr = [];
        if (childrenKey?.node?.value) {
          try {
            childArr = JSON.parse(childrenKey.node.value);
          } catch (err) {
            console.error("❌ Error parsing 'childrenkey' =>", err);
          }
        }
        if (childArr.includes(variantNode.id)) {
          console.log(
            `✅ Identified CHILD => MASTER: ${possibleMaster.id}, CHILD: ${variantNode.id}`
          );
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

    hasNextPage = allData.data?.products?.pageInfo?.hasNextPage;
    cursor = allData.data?.products?.pageInfo?.endCursor;
  }

  console.log("❌ No referencing MASTER found; thus, this is not a CHILD either.");
  return null;
}

/*
 * ------------------------------------------------------------------
 * 4.1) GET THE "qtymanagement" (CHILD DIVISOR)
 * ------------------------------------------------------------------
 */
async function getVariantQtyManagement(shopDomain, adminHeaders, variantId) {
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
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
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
  const valStr = data?.data?.productVariant?.metafield?.value;
  return valStr ? parseInt(valStr, 10) : 1;
}

/*
 * ------------------------------------------------------------------
 * 4.2) GET CHILDREN (inventoryItemId) OF A MASTER
 * ------------------------------------------------------------------
 */
async function getChildrenInventoryItems(shopDomain, adminHeaders, masterVariantId) {
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
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
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
    console.error("❌ getChildrenInventoryItems => error retrieving children for MASTER", data.errors);
    return [];
  }

  const variant = data?.data?.productVariant;
  if (!variant) {
    console.error(`❌ MASTER variant not found => ${masterVariantId}`);
    return [];
  }

  let childIds = [];
  if (variant.metafield?.value) {
    try {
      childIds = JSON.parse(variant.metafield.value);
    } catch (err) {
      console.error("❌ Error parsing 'childrenkey' =>", err);
      return [];
    }
  }

  // Normalise
  const normChildIds = childIds.map((cid) =>
    cid.startsWith("gid://shopify/ProductVariant/")
      ? cid.replace("gid://shopify/ProductVariant/", "")
      : cid
  );

  // 1) Attempt to locate them within the MASTER's product
  const productEdges = variant.product?.variants?.edges || [];
  let foundChildren = [];
  let missingIds = [];

  for (const cid of normChildIds) {
    const childEdge = productEdges.find(
      (e) => e.node.id.replace("gid://shopify/ProductVariant/", "") === cid
    );
    if (!childEdge) {
      console.warn(`⚠️ Child not found within the same product => ${cid}`);
      missingIds.push(cid);
    } else {
      foundChildren.push({
        variantId: childEdge.node.id,
        inventoryItemId: childEdge.node.inventoryItem?.id,
      });
    }
  }

  // 2) Fallback query for missing IDs
  if (missingIds.length > 0) {
    console.log(`🔎 Attempting a fallback fetch for missing variant IDs =>`, missingIds);
    const fallbackQuery = `
      query GetMissingVariants($variantIds: [ID!]!) {
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
    const fallResp = await fetch(
      `https://${shopDomain}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: fallbackQuery,
          variables: {
            variantIds: missingIds.map((x) => `gid://shopify/ProductVariant/${x}`),
          },
        }),
      }
    );
    const fallData = await fallResp.json();
    if (fallData.errors) {
      console.error("❌ getChildrenInventoryItems => fallback error =>", fallData.errors);
    } else {
      for (const node of fallData.data?.nodes || []) {
        if (node && node.inventoryItem?.id) {
          foundChildren.push({
            variantId: node.id,
            inventoryItemId: node.inventoryItem.id,
          });
        } else {
          console.warn(`⚠️ Missing inventoryItem for => ${node?.id}`);
        }
      }
    }
  }

  console.log("✅ Final children => MASTER:", JSON.stringify(foundChildren, null, 2));
  return foundChildren;
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
    console.log(`Lock is active => deferring new update for key: ${key}`);
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
 * 6) GET CURRENT "available" QTY
 * ------------------------------------------------------------------
 */
async function getCurrentAvailableQuantity(shopDomain, adminHeaders, inventoryItemId, locationId) {
  async function doQuery(iid, locId) {
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
    const resp = await fetch(
      `https://${shopDomain}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables: { inventoryItemId: iid } }),
      }
    );
    const data = await resp.json();
    const item = data?.data?.inventoryItem;
    if (!item) return null;
    const edges = item.inventoryLevels?.edges || [];
    const match = edges.find((e) => e.node.location.id === `gid://shopify/Location/${locId}`);
    if (!match) return null;
    const availableEntry = match.node.quantities.find((q) => q.name === "available");
    return availableEntry ? availableEntry.quantity : 0;
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

  console.log(`⚠️ This item or location was not found => attempting activation => ${finalId}, loc:${locationId}`);
  const numericId = finalId.replace("gid://shopify/InventoryItem/", "");
  try {
    await activateInventoryItem(shopDomain, adminHeaders, numericId, locationId);
  } catch (err) {
    console.warn("⚠️ Activation failed =>", err.message);
    return 0;
  }

  qty = await doQuery(finalId, locationId);
  if (qty === null) {
    return 0;
  }
  return qty;
}

/*
 * ------------------------------------------------------------------
 * HELPER => GET INVENTORY ITEM ID FROM A VARIANT ID
 * ------------------------------------------------------------------
 */
async function getInventoryItemIdFromVariantId(shopDomain, adminHeaders, variantId) {
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
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
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
    console.warn(`No inventoryItem found for variantId: ${variantId}`);
    return null;
  }
  return itemId.replace("gid://shopify/InventoryItem/", "");
}

/*
 * ------------------------------------------------------------------
 * 7) LISTENING WINDOW IMPLEMENTATION
 * ------------------------------------------------------------------
 */
const aggregatorMap = new Map(); // key: (masterItemId + locationId) => { events: [...], timer }

function addEventToAggregator(comboKey, event) {
  if (aggregatorMap.has(comboKey)) {
    const aggregator = aggregatorMap.get(comboKey);
    aggregator.events.push(event);
  } else {
    const aggregator = { events: [event], timer: null };
    aggregatorMap.set(comboKey, aggregator);

    // 5-second window
    aggregator.timer = setTimeout(() => {
      processAggregatorEvents(comboKey);
    }, 5000);
  }
}

async function processAggregatorEvents(comboKey) {
  const aggregator = aggregatorMap.get(comboKey);
  if (!aggregator) return;

  const { events } = aggregator;
  aggregatorMap.delete(comboKey);

  console.log(
    `⌛ Listening window closed => combo:${comboKey}, total events: ${events.length}`
  );

  // We'll pick the last event for each child + possibly one master event
  const finalChildMap = new Map();
  let finalMaster = null;

  for (const ev of events) {
    if (ev.isMaster) {
      finalMaster = ev; // Overwrite if multiple MASTER updates occurred
    } else {
      finalChildMap.set(ev.childVariantId, ev); // Overwrite if multiple CHILD updates
    }
  }

  // Process child events first
  for (const [childVarId, ev] of finalChildMap) {
    try {
      await handleChildEvent(ev);
    } catch (err) {
      console.error("handleChildEvent => error =>", err);
    }
  }

  // Then the master
  if (finalMaster) {
    try {
      await handleMasterEvent(finalMaster);
    } catch (err) {
      console.error("handleMasterEvent => error =>", err);
    }
  }

  console.log(`✅ Aggregator processing complete => combo:${comboKey}`);
}

/**
 * CHILD => difference-based => newMaster = masterOld + (childDiff * childDivisor)
 * Then recalc siblings => if childDivisor=1 => child's qty = MASTER exactly
 */
async function handleChildEvent(ev) {
  console.log(
    `handleChildEvent => childVariant:${ev.childVariantId}, oldQty:${ev.oldQty}, newQty:${ev.newQty}`
  );
  const { shopDomain, adminHeaders } = ev;

  const childDiff = ev.newQty - ev.oldQty;

  // Fetch childDivisor
  const childDivisor = await getVariantQtyManagement(shopDomain, adminHeaders, ev.childVariantId);
  console.log(`childDivisor => ${childDivisor}`);

  // Retrieve MASTER's old quantity
  const masterOldQty = await getCurrentAvailableQuantity(
    shopDomain,
    adminHeaders,
    ev.masterInventoryItemId,
    ev.locationId
  );
  console.log(`masterOldQty => ${masterOldQty}`);

  // new MASTER => masterOldQty + (childDiff * childDivisor)
  const scaledDiff = childDiff * childDivisor;
  const newMasterQty = masterOldQty + scaledDiff;
  console.log(`newMasterQty => ${newMasterQty}`);

  // 1) Update the CHILD's quantity in Shopify
  await setInventoryQuantity(
    shopDomain,
    adminHeaders,
    ev.inventoryItemId,
    ev.locationId,
    ev.newQty
  );

  // 2) If MASTER's qty has changed
  if (newMasterQty !== masterOldQty) {
    await setInventoryQuantity(
      shopDomain,
      adminHeaders,
      ev.masterInventoryItemId,
      ev.locationId,
      newMasterQty,
      true
    );
  }

  // 3) Recalculate siblings => if childDivisor=1 => child = MASTER
  const siblings = await getChildrenInventoryItems(shopDomain, adminHeaders, ev.masterVariantId);
  const finalMasterQty = await getCurrentAvailableQuantity(
    shopDomain,
    adminHeaders,
    ev.masterInventoryItemId,
    ev.locationId
  );

  const updatedVariants = new Set();
  updatedVariants.add(ev.childVariantId);
  if (newMasterQty !== masterOldQty) {
    updatedVariants.add(ev.masterVariantId);
  }

  for (const s of siblings) {
    // Skip the triggering child
    const sid = s.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
    if (sid === String(ev.inventoryItemId)) {
      continue;
    }
    const sDivisor = await getVariantQtyManagement(shopDomain, adminHeaders, s.variantId);

    let newSQty;
    if (sDivisor === 1) {
      // always match MASTER
      newSQty = finalMasterQty;
    } else {
      newSQty = Math.floor(finalMasterQty / (sDivisor || 1));
    }

    const oldSQty = await getCurrentAvailableQuantity(shopDomain, adminHeaders, sid, ev.locationId);
    if (newSQty !== oldSQty) {
      console.log(`Sibling => old:${oldSQty}, new:${newSQty}, divisor:${sDivisor}`);
      await setInventoryQuantity(shopDomain, adminHeaders, sid, ev.locationId, newSQty, true);
      updatedVariants.add(s.variantId);
    }
  }

  // 4) Update qtyold for the CHILD, MASTER, and siblings
  for (const vid of updatedVariants) {
    let finalQty = 0;
    if (vid === ev.childVariantId) {
      finalQty = ev.newQty;
    } else if (vid === ev.masterVariantId) {
      finalQty = newMasterQty;
    } else {
      // A sibling => fetch final
      const siblingInvId = await getInventoryItemIdFromVariantId(shopDomain, adminHeaders, vid);
      if (!siblingInvId) continue;
      const realQty = await getCurrentAvailableQuantity(
        shopDomain,
        adminHeaders,
        siblingInvId,
        ev.locationId
      );
      finalQty = realQty;
    }
    await setQtyOldValue(shopDomain, adminHeaders, vid, finalQty);
  }
}

/**
 * MASTER => recalc children => if childDivisor=1 => child=MASTER, else floor(MASTER / childDivisor)
 */
async function handleMasterEvent(ev) {
  const { shopDomain, adminHeaders } = ev;
  console.log(`handleMasterEvent => oldQty:${ev.oldQty}, newQty:${ev.newQty}`);

  // Force MASTER quantity if needed
  const shopMasterQty = await getCurrentAvailableQuantity(
    shopDomain,
    adminHeaders,
    ev.inventoryItemId,
    ev.locationId
  );
  if (shopMasterQty !== ev.newQty) {
    await setInventoryQuantity(shopDomain, adminHeaders, ev.inventoryItemId, ev.locationId, ev.newQty);
  }

  // Recalculate children
  const children = await getChildrenInventoryItems(shopDomain, adminHeaders, ev.variantId);
  const updatedVariants = new Set();
  updatedVariants.add(ev.variantId);

  for (const c of children) {
    const cid = c.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
    const dv = await getVariantQtyManagement(shopDomain, adminHeaders, c.variantId);

    let newCQty;
    if (dv === 1) {
      newCQty = ev.newQty;
    } else {
      newCQty = Math.floor(ev.newQty / (dv || 1));
    }

    const oldCQty = await getCurrentAvailableQuantity(shopDomain, adminHeaders, cid, ev.locationId);
    if (newCQty !== oldCQty) {
      await setInventoryQuantity(shopDomain, adminHeaders, cid, ev.locationId, newCQty, true);
      updatedVariants.add(c.variantId);
    }
  }

  // Update 'qtyold' for MASTER + changed children
  for (const vId of updatedVariants) {
    if (vId === ev.variantId) {
      await setQtyOldValue(shopDomain, adminHeaders, vId, ev.newQty);
    } else {
      const childInvId = await getInventoryItemIdFromVariantId(shopDomain, adminHeaders, vId);
      if (!childInvId) continue;
      const realChildQty = await getCurrentAvailableQuantity(
        shopDomain,
        adminHeaders,
        childInvId,
        ev.locationId
      );
      await setQtyOldValue(shopDomain, adminHeaders, vId, realChildQty);
    }
  }
}

/*
 * ------------------------------------------------------------------
 * 8) MAIN WEBHOOK HANDLER
 * ------------------------------------------------------------------
 */
export const action = async ({ request }) => {
  console.log("🔔 Inventory Webhook => aggregator + difference-based + childDivisor=1 logic.");

  // 1) Parse raw body
  const rawBody = await request.text();
  const payload = JSON.parse(rawBody);
  console.log("Webhook payload:", payload);

  // 2) Verify HMAC
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

  // 3) Short-term dedup => 10s
  const dedupKey = buildExactDedupKey(payload);
  if (hasExactKey(dedupKey)) {
    console.log(`Skipping repeated => ${dedupKey}`);
    return new Response("Duplicate skip", { status: 200 });
  }
  markExactKey(dedupKey);

  // 4) Predicted updates => skip
  const pKey = buildPredictedKey(payload.inventory_item_id, payload.location_id, payload.available);
  if (hasPredictedUpdate(pKey)) {
    console.log(`Skipping => predicted future update => ${pKey}`);
    return new Response("Skipped => predicted future update", { status: 200 });
  }

  // 5) 6-second item+location lock
  const shortComboKey = `${payload.inventory_item_id}-${payload.location_id}`;
  if (hasComboKey(shortComboKey)) {
    console.log(`Skipping => combo locked => ${shortComboKey}`);
    return new Response("Skipped => 6s combo lock", { status: 200 });
  }
  markComboKey(shortComboKey);

  // 6) Identify the shop domain from the webhook header
  const shopDomain = request.headers.get("X-Shopify-Shop-Domain");
  if (!shopDomain) {
    console.error("No X-Shopify-Shop-Domain header => cannot retrieve tokens");
    return new Response("Shop domain missing", { status: 400 });
  }

  // 7) Retrieve admin headers from the DB
  let adminHeaders, adminApiUrl;
  try {
    const result = await getShopSessionHeaders(shopDomain);
    adminHeaders = result.adminHeaders;
    adminApiUrl = result.adminApiUrl;
    console.log(`Admin client auth => success for shop: ${shopDomain}`);
  } catch (err) {
    console.error("Auth error =>", err);
    return new Response("Authentication (DB) failed", { status: 403 });
  }

  // 8) MAIN LOGIC
  const locationId = payload.location_id;
  const inventoryItemId = payload.inventory_item_id;
  const newQty = payload.available;

  // Determine if this item is MASTER or CHILD
  const info = await getMasterChildInfo(shopDomain, adminHeaders, inventoryItemId);
  if (!info) {
    console.log("No MASTER/CHILD relationship found; performing a standard update without difference-based logic.");
    await setInventoryQuantity(shopDomain, adminHeaders, inventoryItemId, locationId, newQty);
    return new Response("No Master/Child => performed a direct update", { status: 200 });
  }

  // Read oldQty from the 'qtyold' metafield
  let variantId;
  let isMaster = false;

  if (info.isMaster) {
    isMaster = true;
    variantId = info.variantId;
  } else {
    isMaster = false;
    variantId = info.childVariantId;
  }
  const oldQty = await getQtyOldValue(shopDomain, adminHeaders, variantId);
  console.log(`(qtyold) => old:${oldQty}, new:${newQty}`);

  // aggregator key => for MASTER => (masterInventoryItemId + locationId)
  // for CHILD => (masterInventoryItemId + locationId) as well
  let comboKey;
  if (info.isMaster) {
    comboKey = `${info.inventoryItemId}-${locationId}`;
  } else {
    comboKey = `${info.masterInventoryItemId}-${locationId}`;
  }

  // Build the event object
  const eventObj = {
    shopDomain,
    adminHeaders,
    isMaster,
    locationId,
    newQty,
    oldQty,
  };

  if (info.isChild) {
    eventObj.masterInventoryItemId = info.masterInventoryItemId;
    eventObj.masterVariantId = info.masterVariantId;
    eventObj.childVariantId = info.childVariantId;
    eventObj.inventoryItemId = info.inventoryItemId; // child's inventory item
  } else {
    // MASTER
    eventObj.variantId = info.variantId;
    eventObj.inventoryItemId = info.inventoryItemId;
  }

  // 9) Pass this to the aggregator => short queue
  addEventToAggregator(comboKey, eventObj);

  return new Response("Event queued => waiting for aggregator to finalise", { status: 200 });
};
