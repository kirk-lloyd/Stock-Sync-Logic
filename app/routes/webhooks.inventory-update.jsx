import { json } from "@remix-run/node";
import crypto from "crypto";

/*
// ------------------------------------------------------------------
// A) DEDUPLICATION: EXACT PAYLOAD (10s)
// ------------------------------------------------------------------
*/
const recentlyProcessedExact = new Map();

/**
 * Mark this payload (inventory_item_id, location_id, available, updated_at)
 * as processed for 10s so we skip identical events within that window.
 */
function markExactKey(key) {
  recentlyProcessedExact.set(key, Date.now());
  setTimeout(() => {
    recentlyProcessedExact.delete(key);
  }, 10000);
}

/**
 * Check if we've processed an identical payload in the last 10s.
 */
function hasExactKey(key) {
  return recentlyProcessedExact.has(key);
}

/**
 * Build a key from the Shopify payload to identify duplicates.
 */
function buildExactDedupKey(payload) {
  const { inventory_item_id, location_id, available, updated_at } = payload;
  return `${inventory_item_id}-${location_id}-${available}-${updated_at}`;
}

/*
// ------------------------------------------------------------------
// B) 6-SECOND LOCK FOR (INVENTORY_ITEM + LOCATION)
// ------------------------------------------------------------------
*/
const recentlyTouched = new Map();

/**
 * Lock a (item + location) combination for 6 seconds to skip re-entrant loops.
 */
function markComboKey(key) {
  recentlyTouched.set(key, Date.now());
  setTimeout(() => {
    recentlyTouched.delete(key);
  }, 6000);
}

/**
 * Check if the (item + location) combo is still locked.
 */
function hasComboKey(key) {
  return recentlyTouched.has(key);
}

/*
// ------------------------------------------------------------------
// 1) HMAC VERIFICATION
// ------------------------------------------------------------------
*/
function verifyHmac(body, hmacHeader, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

/*
// ------------------------------------------------------------------
// 2) ACTIVATING AN INVENTORY ITEM IN A LOCATION (IF NEEDED)
// ------------------------------------------------------------------
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
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: TOGGLE_ACTIVATION_MUTATION,
        variables: {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
          locationId: `gid://shopify/Location/${locationId}`
        }
      })
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
// ------------------------------------------------------------------
// 3) SET INVENTORY QUANTITY
// ------------------------------------------------------------------
*/
async function setInventoryQuantity(adminHeaders, inventoryItemId, locationId, quantity, internal = false) {
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

  // Used purely for logging references in Shopify's admin UI
  const referenceDocumentUriValue = internal
    ? "https://yoursite.example/by_app/internal-update"
    : "https://yoursite.example/external-update";

  const actionId = `${cleanInventoryItemId}-${locationId}`;
  console.log(
    `🔧 setInventoryQuantity => (Action ID: ${actionId}), item:${cleanInventoryItemId}, location:${locationId}, qty:${quantity}, internal:${internal}`
  );

  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json"
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
                quantity
              }
            ]
          }
        }
      })
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
// ------------------------------------------------------------------
// 4) DETERMINE IF ITEM IS MASTER OR CHILD
// ------------------------------------------------------------------
*/
async function getMasterChildInfo(adminHeaders, inventoryItemId) {
  console.log(`🔍 getMasterChildInfo => checking itemId ${inventoryItemId}`);

  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json"
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
        }
      })
    }
  );

  const data = await response.json();
  const variantNode = data?.data?.inventoryItem?.variant;
  if (!variantNode) {
    console.log("❌ No variant => no MASTER/CHILD relationship found.");
    return null;
  }

  const metafields = variantNode.metafields?.edges || [];
  const masterField = metafields.find(
    m => m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
  );
  const isMaster = masterField?.node?.value?.trim().toLowerCase() === "true";

  if (isMaster) {
    console.log("✅ This variant is a MASTER.");
    const childrenField = metafields.find(
      m => m.node.namespace === "projektstocksyncchildren" && m.node.key === "childrenkey"
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
      children: childrenIds
    };
  }

  // Otherwise, see if it's a CHILD
  console.log("🔍 Searching storewide for a MASTER referencing this item as CHILD...");
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const allProductsQuery = `
      query getAllVariants($cursor: String) {
        products(first: 50, after: $cursor) {
          edges {
            node {
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
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: allProductsQuery, variables: { cursor } })
      }
    );

    const allProdsData = await allProdsResp.json();
    const allProducts = allProdsData?.data?.products?.edges || [];

    for (const productEdge of allProducts) {
      for (const variantEdge of productEdge.node.variants.edges) {
        const possibleMaster = variantEdge.node;
        const pmfs = possibleMaster.metafields?.edges || [];

        const mmf = pmfs.find(
          m => m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
        );
        const isMasterVariant = mmf?.node?.value?.trim().toLowerCase() === "true";
        if (!isMasterVariant) continue;

        const childrenKeyField = pmfs.find(
          m => m.node.namespace === "projektstocksyncchildren" && m.node.key === "childrenkey"
        );
        let possibleChildren = [];
        if (childrenKeyField?.node?.value) {
          try {
            possibleChildren = JSON.parse(childrenKeyField.node.value);
          } catch (err) {
            console.error("❌ childrenkey parse error =>", err);
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
              : null
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
// ------------------------------------------------------------------
// 4.1) GET THE CHILD DIVISOR (QTYMANAGEMENT)
// ------------------------------------------------------------------
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
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables: { variantId } })
    }
  );

  const data = await resp.json();
  const value = data?.data?.productVariant?.metafield?.value;
  return value ? parseInt(value, 10) : 1;
}

/*
// ------------------------------------------------------------------
// 4.2) GET CHILDREN INVENTORY ITEMS FROM A MASTER
// ------------------------------------------------------------------
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
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables: { variantId: masterVariantId } })
    }
  );

  const data = await resp.json();
  if (data.errors) {
    console.error(`❌ getChildrenInventoryItems => error for MASTER:${masterVariantId}`, data.errors);
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

  const normChildIds = childIds.map(id =>
    id.startsWith("gid://shopify/ProductVariant/")
      ? id.replace("gid://shopify/ProductVariant/", "")
      : id
  );

  const allVariantEdges = variant.product?.variants?.edges || [];
  let childrenVariants = normChildIds
    .map(cid => {
      const childEdge = allVariantEdges.find(
        e => e.node.id.replace("gid://shopify/ProductVariant/", "") === cid
      );
      if (!childEdge) {
        console.warn(`⚠️ Child variant not found in product => ${cid}`);
        return null;
      }
      return {
        variantId: childEdge.node.id,
        inventoryItemId: childEdge.node.inventoryItem?.id
      };
    })
    .filter(Boolean);

  // If some children didn't appear in the immediate product listing, do a fallback GraphQL fetch
  const foundIds = childrenVariants.map(c =>
    c.variantId.replace("gid://shopify/ProductVariant/", "")
  );
  const missingIds = normChildIds.filter(id => !foundIds.includes(id));
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
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: variantQuery,
          variables: {
            variantIds: missingIds.map(id => `gid://shopify/ProductVariant/${id}`)
          }
        })
      }
    );
    const missingData = await missingResp.json();
    if (!missingData.errors) {
      for (const node of missingData.data.nodes) {
        if (node?.inventoryItem?.id) {
          childrenVariants.push({
            variantId: node.id,
            inventoryItemId: node.inventoryItem.id
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
// ------------------------------------------------------------------
// 5) CONCURRENCY LOCK
// ------------------------------------------------------------------
*/
const updateLocks = new Map();

/**
 * Process updates in series for a given key. If there's already an update
 * in progress, we queue the new one until the current completes.
 */
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
// ------------------------------------------------------------------
// 6) GET CURRENT "available" QTY (ACTIVATING IF NECESSARY)
// ------------------------------------------------------------------
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
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables: { inventoryItemId: itemId } })
      }
    );

    const data = await response.json();
    const item = data?.data?.inventoryItem;
    if (!item) {
      return null;
    }

    const edges = item.inventoryLevels?.edges || [];
    const match = edges.find(e => e.node.location.id === `gid://shopify/Location/${locId}`);
    if (!match) {
      return null;
    }

    // Look for the "available" quantity
    const quantityEntry = match.node.quantities.find(q => q.name === "available");
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

  // Attempt the query
  let qty = await doQuery(finalId, locationId);
  if (qty !== null) {
    return qty;
  }

  console.log(`⚠️ Not found => activating => ${finalId}, loc:${locationId}`);
  const numericId = finalId.replace("gid://shopify/InventoryItem/", "");
  try {
    await activateInventoryItem(adminHeaders, numericId, locationId);
  } catch (err) {
    console.warn(`⚠️ Activation failed => ${err.message} => returning 0`);
    return 0;
  }

  // Re-query after activation
  qty = await doQuery(finalId, locationId);
  if (qty === null) {
    console.warn(`⚠️ Still not found => returning 0 => item:${finalId}, loc:${locationId}`);
    return 0;
  }
  return qty;
}

/*
// ------------------------------------------------------------------
// 7) MAIN WEBHOOK HANDLER
// ------------------------------------------------------------------
*/
export const action = async ({ request }) => {
  console.log("🔔 Inventory Update Webhook received.");

  // 1) Parse the raw body
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

  // 3) 10s dedup check
  const dedupKeyExact = buildExactDedupKey(payload);
  if (hasExactKey(dedupKeyExact)) {
    console.log(`Skipping repeated event => ${dedupKeyExact}`);
    return new Response("Duplicate skip", { status: 200 });
  }
  markExactKey(dedupKeyExact);

  // 4) 6s combo lock
  const shortComboKey = `${payload.inventory_item_id}-${payload.location_id}`;
  if (hasComboKey(shortComboKey)) {
    console.log(`Skipping => combo locked => ${shortComboKey}`);
    return new Response("Skipped => 6s combo lock", { status: 200 });
  }
  markComboKey(shortComboKey);

  // 5) Admin auth
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

  // 6) Extract relevant data from the webhook
  const inventoryItemId = payload.inventory_item_id;
  const newQuantity = payload.available; // new child quantity
  const locationId = payload.location_id;
  console.log(`Received => item:${inventoryItemId}, loc:${locationId}, newQty:${newQuantity}`);

  // Read the old child quantity from Shopify
  const oldChildQty = await getCurrentAvailableQuantity(admin.headers, inventoryItemId, locationId);
  console.log(`(Old child's available) => ${oldChildQty}`);

  // 7) Immediately set the child's inventory to the new quantity from the webhook
  try {
    console.log(`Updating child's own qty => from ${oldChildQty} to ${newQuantity}`);
    await setInventoryQuantity(admin.headers, inventoryItemId, locationId, newQuantity);
  } catch (err) {
    console.error("Error setting child's inventory =>", err);
    return json({ error: err.message }, { status: 400 });
  }

  // 8) Use concurrency lock to avoid collisions
  await processWithDeferred(
    shortComboKey,
    {
      oldChildQty,
      newQuantity,
      inventoryItemId,
      locationId,
      admin: admin.headers
    },
    async (update) => {
      const { oldChildQty, newQuantity, inventoryItemId, locationId, admin } = update;

      // Identify if the item is MASTER or CHILD
      const info = await getMasterChildInfo(admin, inventoryItemId);
      if (!info) {
        console.log("No MASTER/CHILD => done.");
        return;
      }

      // ------------------------------------------------------------------
      // CHILD LOGIC => 1) difference-based if childDelta != 0,
      //                2) ratio fallback if childDelta == 0
      // ------------------------------------------------------------------
      if (info.isChild) {
        console.log("Child logic => difference + fallback ratio if needed.");

        // 1) childDelta
        const childDelta = oldChildQty - newQuantity;
        console.log(`childDelta => ${oldChildQty} - ${newQuantity} = ${childDelta}`);

        // 2) child's divisor
        const childDivisor = await getVariantQtyManagement(admin, info.childVariantId);
        console.log(`childDivisor => ${childDivisor}`);

        if (!info.masterInventoryItemId) {
          console.warn("No masterInventoryItemId => skipping updates to MASTER.");
          return;
        }

        // Current MASTER quantity
        const masterOldQty = await getCurrentAvailableQuantity(admin, info.masterInventoryItemId, locationId);
        console.log(`masterOldQty => ${masterOldQty}`);

        // ------------------------------------------------------------------
        // A) If there's a real difference => do difference-based
        // ------------------------------------------------------------------
        if (childDelta !== 0) {
          // example: childDelta=1 => child decreased by 1, childDivisor=3 => subtract 3 from MASTER
          const masterAdjustment = childDelta * childDivisor;
          const newMasterQty = masterOldQty - masterAdjustment;
          console.log(
            `newMasterQty => ${masterOldQty} - (${childDelta} * ${childDivisor}) = ${newMasterQty}`
          );

          if (newMasterQty !== masterOldQty) {
            console.log(`Updating MASTER => from ${masterOldQty} to ${newMasterQty}`);
            await setInventoryQuantity(admin, info.masterInventoryItemId, locationId, newMasterQty, true);
          } else {
            console.log("No MASTER update => same as old quantity.");
          }

          // now recalc siblings from the new MASTER
          const finalMasterQty = await getCurrentAvailableQuantity(admin, info.masterInventoryItemId, locationId);
          await recalcSiblings(admin, finalMasterQty, info.masterVariantId, locationId, inventoryItemId);

        // ------------------------------------------------------------------
        // B) If childDelta=0 => fallback ratio correction
        // ------------------------------------------------------------------
        } else {
          // Sometimes oldChildQty == newQuantity, but the MASTER is still out of sync.
          // e.g. The child was 34 → 33 behind the scenes, so Shopify says old=33, new=33 => 0.
          // We'll do a ratio check to “pull down” the MASTER if leftover is too large.
          console.log("No net difference => performing ratio fallback check.");

          const childWanted = newQuantity * childDivisor; // e.g. 33×3=99
          const leftover = masterOldQty - childWanted;     // e.g. 104-99=5
          console.log(`childWanted => ${childWanted}, leftover => ${leftover}`);

          // If leftover >= 0 => we keep some leftover but ensure leftover < childDivisor
          // by taking leftover2 = leftover % childDivisor, so the final MASTER
          // is childWanted + leftover2. That means leftover remains below childDivisor.
          //
          // Example: leftover=5, childDivisor=3 => leftover2=2 => finalMaster=99+2=101
          // We effectively remove 3 from the MASTER => leftover=2 remains above childWanted=99.
          //
          // If leftover < 0 => childWanted > master => you may want
          // to raise the MASTER to childWanted or do your own logic.
          //
          let finalMaster = masterOldQty;
          if (leftover >= 0) {
            const leftover2 = leftover % childDivisor;
            finalMaster = childWanted + leftover2; // 99 + 2=101
          } else {
            // The child is bigger than the MASTER => optional logic: raise MASTER to childWanted
            finalMaster = childWanted;
          }

          if (finalMaster !== masterOldQty) {
            console.log(`Updating MASTER => from ${masterOldQty} to ${finalMaster}`);
            await setInventoryQuantity(admin, info.masterInventoryItemId, locationId, finalMaster, true);
          } else {
            console.log("MASTER ratio fallback => no update needed => already matches leftover logic.");
          }

          // recalc siblings from finalMaster
          const finalMasterQty = await getCurrentAvailableQuantity(admin, info.masterInventoryItemId, locationId);
          await recalcSiblings(admin, finalMasterQty, info.masterVariantId, locationId, inventoryItemId);
        }

        // Mark MASTER as locked
        markComboKey(`${info.masterInventoryItemId}-${locationId}`);
      }

      // ------------------------------------------------------------------
      // MASTER LOGIC => recalc children => floor(MASTER/childDivisor)
      // ------------------------------------------------------------------
      else if (info.isMaster) {
        console.log("MASTER => recalc children => floor(MASTER/childDivisor)");
        const masterQty = newQuantity;
        await recalcSiblings(admin, masterQty, info.variantId, locationId, null);
      }

      // Finally re-lock this child’s combo
      markComboKey(`${inventoryItemId}-${locationId}`);
    }
  );

  return json({
    message: `Inventory logic complete. 
      1) If item is CHILD and childDelta != 0 => difference-based approach. 
      2) If childDelta=0 => fallback ratio correction (ensuring leftover < childDivisor). 
      3) MASTER => recalc children. 6s locks + 10s dedup in effect.`
  });
};

// ------------------------------------------------------------------
// 8) Helper => Recalc Siblings
// ------------------------------------------------------------------
async function recalcSiblings(adminHeaders, masterQty, masterVariantId, locationId, triggeringChildId) {
  console.log("Recalculating siblings => floor(MASTER / childDivisor). MASTER:", masterQty);
  const siblings = await getChildrenInventoryItems(adminHeaders, masterVariantId);
  console.log("Siblings =>", JSON.stringify(siblings, null, 2));

  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i];
    const sid = s.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
    if (String(sid) === String(triggeringChildId)) {
      console.log(`Skipping the triggering child => ${sid}`);
      continue;
    }
    const sDivisor = await getVariantQtyManagement(adminHeaders, s.variantId);
    const oldSQty = await getCurrentAvailableQuantity(adminHeaders, sid, locationId);
    const newSQty = Math.floor(masterQty / (sDivisor || 1));

    if (newSQty !== oldSQty) {
      console.log(`Sibling => old:${oldSQty}, new:${newSQty}, divisor:${sDivisor}, MASTER:${masterQty}`);
      await setInventoryQuantity(adminHeaders, sid, locationId, newSQty, true);
    } else {
      console.log(`Sibling => no change => old:${oldSQty}, new:${newSQty}`);
    }
    markComboKey(`${sid}-${locationId}`);
  }
}
