import { json } from "@remix-run/node";
import crypto from "crypto";

/**
 * ------------------------------------------------------------------
 * DIRECT APPROACH FOR CHILD => MASTER
 *
 *  - We do NOT rely on oldChildQty, because Shopify's webhook
 *    only tells us the new child quantity, not the old one.
 *
 * Steps if the item is CHILD:
 *   1) The webhook says child is now quantity X.
 *   2) We set MASTER to (X * childDivisor).
 *   3) We recalc siblings => floor(MASTER / siblingDivisor).
 *
 * This ensures the MASTER and siblings remain in sync purely
 * based on the new child quantity, no old child quantity needed.
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
 * We use this to skip the known, intentional updates we trigger,
 * thereby preventing infinite or repeated loops.
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
  // Normalise inventoryItemId
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
    `🔧 setInventoryQuantity => (Action ID: ${actionId}), ` +
    `item: ${cleanInventoryItemId}, location: ${locationId}, qty: ${quantity}, internal: ${internal}`
  );

  // Mark as a predicted update so we ignore the resulting webhook
  const predictedKey = buildPredictedKey(
    cleanInventoryItemId.replace("gid://shopify/InventoryItem/", ""),
    locationId,
    quantity
  );
  markPredictedUpdate(predictedKey);

  // Send the GraphQL request to set quantity
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
 * 4) DETERMINE IF THIS ITEM IS MASTER OR CHILD
 * ------------------------------------------------------------------
 */
async function getMasterChildInfo(adminHeaders, inventoryItemId) {
  console.log(`🔍 getMasterChildInfo => checking itemId ${inventoryItemId}`);

  // 1) Get the variant that belongs to this InventoryItem
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
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`
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

  // 2) Check variant’s metafields for MASTER or CHILD
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
      variantId: variantNode.id,
      inventoryItemId,
      children: childrenIds,
    };
  }

  // 3) If not MASTER, see if it's a CHILD
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

        // If our variant matches one of these possibleChildren
        if (possibleChildren.includes(variantNode.id)) {
          console.log(`✅ Found CHILD => MASTER:${possibleMaster.id}, CHILD:${variantNode.id}`);
          return {
            isChild: true,
            childVariantId: variantNode.id,
            masterVariantId: possibleMaster.id,
            masterInventoryItemId: possibleMaster.inventoryItem?.id
              ? possibleMaster.inventoryItem.id.replace("gid://shopify/InventoryItem/", "")
              : null,
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

  // If some are missing from the same product, try a direct query
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
      console.error("❌ getChildrenInventoryItems => error retrieving missing variants:", missingData.errors);
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
 * 6) GET CURRENT "available" QTY (FOR MASTER & SIBLINGS)
 * ------------------------------------------------------------------
 * We don't need old CHILD QTY, because our logic is direct:
 * MASTER = (newChildQty * childDivisor).
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
      return null;
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

  // normalise
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

  // Attempt to activate the item
  console.log(`⚠️ Not found => activating item => ${finalId}, loc:${locationId}`);
  const numericId = finalId.replace("gid://shopify/InventoryItem/", "");
  try {
    await activateInventoryItem(adminHeaders, numericId, locationId);
  } catch (err) {
    console.warn(`⚠️ Activation failed => ${err.message} => returning 0`);
    return 0;
  }

  // Re-query once
  qty = await doQuery(finalId, locationId);
  if (qty === null) {
    console.warn(`⚠️ After activation => still not found => returning 0 => item:${finalId}, loc:${locationId}`);
    return 0;
  }
  return qty;
}

/*
 * ------------------------------------------------------------------
 * 7) MAIN WEBHOOK HANDLER
 * ------------------------------------------------------------------
 */
export const action = async ({ request }) => {
  console.log("🔔 Inventory Webhook => DIRECT (no old child needed).");

  // 1) parse raw body
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

  // 5) 6-second combo lock => item+location
  const shortComboKey = `${payload.inventory_item_id}-${payload.location_id}`;
  if (hasComboKey(shortComboKey)) {
    console.log(`Skipping => combo locked => ${shortComboKey}`);
    return new Response("Skipped => 6s combo lock", { status: 200 });
  }
  markComboKey(shortComboKey);

  // 6) admin auth
  let admin;
  try {
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!token) {
      throw new Error("Missing SHOPIFY_ACCESS_TOKEN");
    }
    admin = { headers: { "X-Shopify-Access-Token": token } };
    console.log("Admin client auth => success.");
  } catch (err) {
    console.error("Auth error =>", err);
    return new Response("Authentication failed", { status: 403 });
  }

  // 7) Extract
  const inventoryItemId = payload.inventory_item_id;
  const newChildQty = payload.available;  // the new child quantity
  const locationId = payload.location_id;
  console.log(`Received => CHILD item:${inventoryItemId}, loc:${locationId}, newQty:${newChildQty}`);

  // (A) Immediately set the child to the webhook's new qty
  try {
    console.log(`For safety, set child's own qty => ${newChildQty} (direct from webhook)`);
    await setInventoryQuantity(admin.headers, inventoryItemId, locationId, newChildQty);
  } catch (err) {
    console.error("Error setting child's inventory =>", err);
    return json({ error: err.message }, { status: 400 });
  }

  // concurrency lock => process in series
  await processWithDeferred(
    shortComboKey,
    { newChildQty, inventoryItemId, locationId, admin: admin.headers },
    async (update) => {
      const { newChildQty, inventoryItemId, locationId, admin } = update;

      // 1) Check if MASTER or CHILD
      const info = await getMasterChildInfo(admin, inventoryItemId);
      if (!info) {
        console.log("No MASTER/CHILD => done.");
        return;
      }

      // =============== CHILD LOGIC (direct approach) ===============
      if (info.isChild) {
        console.log(
          "Detected CHILD => We do: MASTER = (newChildQty * childDivisor). " +
          "No old child needed."
        );

        if (!info.masterInventoryItemId) {
          console.warn("No masterInventoryItemId => skip child logic.");
          return;
        }

        // (a) fetch childDivisor
        const childDivisor = await getVariantQtyManagement(admin, info.childVariantId);
        console.log(`childDivisor => ${childDivisor}`);

        // (b) newMaster = newChildQty * childDivisor
        const newMasterQty = newChildQty * childDivisor;
        console.log(`newMasterQty => ${newMasterQty}`);

        // (c) fetch old MASTER to see if we actually need to update
        const masterOldQty = await getCurrentAvailableQuantity(admin, info.masterInventoryItemId, locationId);
        console.log(`masterOldQty => ${masterOldQty}`);

        if (newMasterQty !== masterOldQty) {
          console.log(`Updating MASTER from ${masterOldQty} => ${newMasterQty}`);
          await setInventoryQuantity(admin, info.masterInventoryItemId, locationId, newMasterQty, true);
        } else {
          console.log("No MASTER update => already matches newChildQty * childDivisor.");
        }

        // (d) recalc siblings => floor(MASTER / siblingDivisor)
        const siblings = await getChildrenInventoryItems(admin, info.masterVariantId);
        const finalMasterQty = await getCurrentAvailableQuantity(admin, info.masterInventoryItemId, locationId);

        console.log(`Siblings => finalMaster => ${finalMasterQty}`);
        for (const sibling of siblings) {
          const sid = sibling.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
          if (sid === String(inventoryItemId)) {
            console.log(`Skipping triggering child => ${sibling.inventoryItemId}`);
            continue;
          }
          const sDivisor = await getVariantQtyManagement(admin, sibling.variantId);
          const oldSQty = await getCurrentAvailableQuantity(admin, sid, locationId);
          const newSQty = Math.floor(finalMasterQty / (sDivisor || 1));
          const needsUpdate = oldSQty !== newSQty;
          console.log(
            `Sibling => old:${oldSQty}, new:${newSQty}, divisor:${sDivisor}, MASTER:${finalMasterQty}, update? ${needsUpdate}`
          );
          if (needsUpdate) {
            await setInventoryQuantity(admin, sid, locationId, newSQty, true);
          }
          markComboKey(`${sid}-${locationId}`);
        }
        markComboKey(`${info.masterInventoryItemId}-${locationId}`);
      }

      // =============== MASTER LOGIC ===============
      else if (info.isMaster) {
        console.log(
          "Detected MASTER => recalc children => floor(MASTER / childDivisor)."
        );
        const masterQty = newChildQty; // The new MASTER quantity from the webhook
        const children = await getChildrenInventoryItems(admin, info.variantId);

        for (const c of children) {
          const cid = c.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
          const dv = await getVariantQtyManagement(admin, c.variantId);
          const oldCQty = await getCurrentAvailableQuantity(admin, cid, locationId);
          const newCQty = Math.floor(masterQty / (dv || 1));
          const updateNeeded = oldCQty !== newCQty;
          console.log(
            `Child => old:${oldCQty}, new:${newCQty}, divisor:${dv}, MASTER:${masterQty}, update? ${updateNeeded}`
          );
          if (updateNeeded) {
            await setInventoryQuantity(admin, cid, locationId, newCQty, true);
          }
          markComboKey(`${cid}-${locationId}`);
        }
      }

      // done => mark combo key
      markComboKey(`${inventoryItemId}-${locationId}`);
    }
  );

  return json({
    message: "Direct approach done. For CHILD => MASTER = (newChildQty * childDivisor)."
  });
};
