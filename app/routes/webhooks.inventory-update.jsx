// app/routes/webhooks.inventory-update.jsx

import { json } from "@remix-run/node";
import crypto from "crypto";
import prisma from "../db.server.js"; // Adjust if your structure differs
import axios from 'axios';
import https from 'https';

/**
 * ------------------------------------------------------------------
 * PROFESSIONAL AUSTRALIAN ENGLISH COMMENTS
 *
 * This code listens for Shopify Inventory Level webhooks and implements:
 *
 * 1) A short "listening window" aggregator (5 seconds). Any near-simultaneous
 *    updates for the same MASTER combination are batched, preventing collisions.
 *
 * 2) "qtyold" logic, but now stored in our Prisma database as the
 *    authoritative source for oldQty retrieval. We still update the
 *    Shopify metafield for reference, but we do not read from it
 *    at the start of the webhook.
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
 *
 * 6) Batch inventory updates to significantly reduce API calls and improve
 *    performance during high-volume update periods.
 *
 * 7) In-memory caching system for metadata that changes infrequently,
 *    reducing redundant API calls.
 *
 * 8) Parallel processing of independent operations using Promise.all()
 *    to reduce overall processing time.
 * ------------------------------------------------------------------
 */

/*
 * ------------------------------------------------------------------
 * 0) SHORT-TERM DEDUPLICATION (10s FOR EXACT PAYLOAD)
 * ------------------------------------------------------------------
 * We store a key in a Map for 10 seconds, to prevent re-processing
 * the exact same payload multiple times within that short window.
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
 * After receiving an update for a specific (inventoryItem, location),
 * we lock it for 6 seconds to avoid re-entries that could cause collisions.
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
 * If we programmatically update inventory in Shopify, we mark that
 * update as "predicted" to avoid re-processing it when Shopify
 * sends back a webhook with the resulting changes.
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
 * CACHE IMPLEMENTATION FOR METAFIELDS AND VARIANT-INVENTORY RELATIONSHIPS
 * ------------------------------------------------------------------
 * Reduces API calls for information that doesn't change frequently
 */

// Caches with expiration time
const metafieldCache = new Map();
const variantInventoryCache = new Map();
const qtyManagementCache = new Map();
const childrenCache = new Map();

// Generic cache function to store values with TTL
function setCacheValue(cache, key, value, ttlMs = 60000) { // 1 minute default
  cache.set(key, {
    value,
    expiry: Date.now() + ttlMs
  });
  
  // Optional: Automatic cleanup after TTL
  setTimeout(() => {
    const entry = cache.get(key);
    // Only remove if this entry hasn't been updated
    if (entry && entry.expiry <= Date.now()) {
      cache.delete(key);
    }
  }, ttlMs);
}

function getCacheValue(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  
  if (entry.expiry <= Date.now()) {
    cache.delete(key);
    return null;
  }
  
  return entry.value;
}

// Function to invalidate caches when relationship changes are detected
function invalidateRelationshipCaches(shopDomain, variantId) {
  const cacheKey = `${shopDomain}:${variantId}`;
  
  // Invalidate related caches
  childrenCache.delete(cacheKey);
  metafieldCache.delete(cacheKey);
  
  console.log(`🧹 Cache invalidated for ${cacheKey}`);
}

/*
 * ------------------------------------------------------------------
 * 1) HMAC VERIFICATION
 * ------------------------------------------------------------------
 * We verify the X-Shopify-Hmac-Sha256 header to ensure authenticity.
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
 * We look up the session record in Prisma, which contains the
 * X-Shopify-Access-Token so we can make Admin API calls.
 */
async function getShopSessionHeaders(shopDomain) {
  // Look up the session in your database
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain },
  });
  if (!session || !session.accessToken) {
    throw new Error(`No session or accessToken found for shop: ${shopDomain}`);
  }

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
 * This function sets the on_hand (available) inventory in Shopify.
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

  // Optional reference link to differentiate internal vs external updates
  const MY_APP_URL = process.env.MY_APP_URL || "https://your-app-url.com";
  const referenceDocumentUriValue = internal
    ? `${MY_APP_URL}/by_app/internal-update`
    : `${MY_APP_URL}/by_app/external-update`;

  // Mark this as a predicted update to avoid re-processing our own changes
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
 * NEW FUNCTION: BATCH INVENTORY UPDATE
 * ------------------------------------------------------------------
 * This function updates multiple inventory levels in a single API
 * call to reduce latency and improve performance
 */
async function setInventoryQuantityBatch(
  shopDomain,
  adminHeaders,
  itemsToUpdate, // Array of {inventoryItemId, locationId, quantity}
  internal = false
) {
  if (!itemsToUpdate.length) return null;
  
  // Optional reference link to differentiate internal vs external updates
  const MY_APP_URL = process.env.MY_APP_URL || "https://your-app-url.com";
  const referenceDocumentUriValue = internal
    ? `${MY_APP_URL}/by_app/internal-batch-update`
    : `${MY_APP_URL}/by_app/external-batch-update`;

  // Normalise the inventory IDs and mark updates as predicted
  const quantities = itemsToUpdate.map(item => {
    let cleanInventoryItemId;
    if (typeof item.inventoryItemId === "string") {
      if (item.inventoryItemId.startsWith("gid://shopify/InventoryItem/")) {
        cleanInventoryItemId = item.inventoryItemId;
      } else {
        cleanInventoryItemId = `gid://shopify/InventoryItem/${item.inventoryItemId}`;
      }
    } else {
      cleanInventoryItemId = `gid://shopify/InventoryItem/${item.inventoryItemId}`;
    }
    
    // Mark as predicted update
    const pKey = buildPredictedKey(
      cleanInventoryItemId.replace("gid://shopify/InventoryItem/", ""),
      item.locationId,
      item.quantity
    );
    markPredictedUpdate(pKey);
    
    return {
      inventoryItemId: cleanInventoryItemId,
      locationId: `gid://shopify/Location/${item.locationId}`,
      quantity: item.quantity
    };
  });
  
  console.log(`🔧 setInventoryQuantityBatch => Updating ${quantities.length} items in batch`);

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
            quantities: quantities,
          },
        },
      }),
    }
  );

  const data = await response.json();
  if (data.errors) {
    console.error("❌ setInventoryQuantityBatch =>", data.errors);
    return null;
  } else {
    console.log(`✅ Inventory batch updated => ${quantities.length} items`);
    return data;
  }
}

/*
 * ------------------------------------------------------------------
 * 3.1) GET/SET QTYOLD METAFIELD ON SHOPIFY (FOR REFERENCE)
 * ------------------------------------------------------------------
 * We still update the 'qtyold' metafield in Shopify, but do not rely
 * on it as our source of truth. We rely on Prisma's DB instead.
 */
async function getQtyOldValue(shopDomain, adminHeaders, variantId) {
  // Typically unused now, but kept for reference or debugging
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
  // Writes newQty to the 'qtyold' metafield in Shopify
  const mutation = `
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
 * OPTIMISED FUNCTION => BATCH UPDATE METAFIELDS
 * ------------------------------------------------------------------
 * Updates multiple metafields in a single operation
 */
async function batchUpdateMetafields(shopDomain, adminHeaders, updates) {
  // updates = [{ownerId, namespace, key, type, value}, ...]
  
  if (!updates || updates.length === 0) return null;
  
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          value
        }
        userErrors {
          field
          message
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
      body: JSON.stringify({
        query: mutation,
        variables: { metafields: updates }
      }),
    }
  );
  
  const data = await resp.json();
  if (data.errors) {
    console.error("❌ batchUpdateMetafields => GraphQL errors:", data.errors);
    return null;
  }
  
  if (data.data?.metafieldsSet?.userErrors?.length) {
    console.error("❌ batchUpdateMetafields => userErrors:", data.data.metafieldsSet.userErrors);
    return null;
  }
  
  console.log(`✅ Updated ${updates.length} metafields in batch`);
  return data;
}

/*
 * ------------------------------------------------------------------
 * OPTIMISED FUNCTION => BATCH UPDATE QTYOLD FOR MULTIPLE VARIANTS
 * ------------------------------------------------------------------
 * Updates qtyold in Shopify metafields for multiple variants
 */
async function setQtyOldValueBatch(shopDomain, adminHeaders, updates) {
  // updates = [{variantId, newQty}, ...]
  const metafieldUpdates = updates.map(update => ({
    ownerId: update.variantId,
    namespace: "projektstocksyncqtyold",
    key: "qtyold",
    type: "number_integer",
    value: String(update.newQty)
  }));
  
  return batchUpdateMetafields(shopDomain, adminHeaders, metafieldUpdates);
}

/*
 * ------------------------------------------------------------------
 * 3.2) GET/SET QTYOLD FROM PRISMA DB
 * ------------------------------------------------------------------
 * We read/write oldQty from our Stockdb model instead of the Shopify
 * metafield. This ensures multi-tenant isolation and faster lookups.
 */

// Normalises a GID so we're left with only the numeric part
function normaliseVariantId(variantId) {
  if (!variantId) return null;
  return variantId.replace("gid://shopify/ProductVariant/", "");
}

async function getQtyOldValueDB(shopDomain, variantId) {
  // 'variantId' might be a GID or a numeric ID; we normalise it
  const normalisedId = normaliseVariantId(variantId);

  const record = await prisma.stockdb.findFirst({
    where: {
      shop: shopDomain,
      productVariantId: normalisedId,
    },
  });

  if (!record) {
    console.log(`No record found for shop:${shopDomain}, variant:${normalisedId}, returning oldQty=0`);
    return 0;
  }

  return record.oldQuantity ?? 0;
}

async function setQtyOldValueDB(shopDomain, variantId, newQty) {
  const normalisedId = normaliseVariantId(variantId);

  // Upsert ensures we either create a new row or update an existing one
  await prisma.stockdb.upsert({
    where: {
      // Typically "shop_productVariantId" or something similar
      shop_productVariantId: {
        shop: shopDomain,
        productVariantId: normalisedId,
      },
    },
    update: { oldQuantity: newQty },
    create: {
      shop: shopDomain,
      productVariantId: normalisedId,
      oldQuantity: newQty,
      title: "Unknown",
      productId: "unknown",
      productHandle: "unknown",
    },
  });

  console.log(`✅ Updated DB 'oldQuantity' => new value: ${newQty} for variant (shop:${shopDomain}): ${normalisedId}`);
}

/*
 * ------------------------------------------------------------------
 * OPTIMISED FUNCTION => BATCH UPDATE QTYOLD IN DB FOR MULTIPLE VARIANTS
 * ------------------------------------------------------------------
 * Updates oldQuantity in Prisma DB for multiple variants
 */
async function setQtyOldValueDBBatch(shopDomain, updates) {
  // updates = [{variantId, newQty}, ...]
  const dbOperations = updates.map(update => {
    const normalisedId = normaliseVariantId(update.variantId);
    
    return prisma.stockdb.upsert({
      where: {
        shop_productVariantId: {
          shop: shopDomain,
          productVariantId: normalisedId,
        }
      },
      update: { oldQuantity: update.newQty },
      create: {
        shop: shopDomain,
        productVariantId: normalisedId,
        oldQuantity: update.newQty,
        title: "Unknown",
        productId: "unknown",
        productHandle: "unknown",
      }
    });
  });
  
  // Execute all DB operations in a transaction
  const results = await prisma.$transaction(dbOperations);
  console.log(`✅ Updated ${results.length} oldQuantity entries in DB`);
  return results;
}

/*
 * ------------------------------------------------------------------
 * 4) DETERMINE IF THIS ITEM IS MASTER OR CHILD
 * ------------------------------------------------------------------
 * OPTIMISED VERSION: Directly checks the variant's metafields
 * to determine master/child relationship without querying all products.
 * - Masters have 'childrenkey' metafield with list of child variants
 * - Children have 'parentmaster' metafield with their master variant
 */
async function getMasterChildInfo(shopDomain, adminHeaders, inventoryItemId) {
  console.log(`🔍 getMasterChildInfo => inventory item: ${inventoryItemId}`);

  // Check cache for this inventory item 
  const cacheKey = `${shopDomain}:inv:${inventoryItemId}`;
  const cachedInfo = getCacheValue(metafieldCache, cacheKey);
  if (cachedInfo !== null) {
    console.log("✅ Retrieved MASTER/CHILD info from cache");
    return cachedInfo;
  }

  // 1) Find the variant (if any) associated with the inventory item
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
                sku
                product {
                  id
                  title
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

  // Check if this variant is a MASTER
  const masterField = metafields.find(
    (m) => m.node.namespace === "projektstocksyncmaster" && m.node.key === "master"
  );
  const isMaster = masterField?.node?.value?.trim().toLowerCase() === "true";

  let result = null;

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
    result = {
      isMaster: true,
      variantId: variantNode.id,
      inventoryItemId,
      sku: variantNode.sku || '',
      children: childrenIds,
    };
  } else {
    // Check if this variant is a CHILD (using the parentmaster metafield)
    const parentMasterField = metafields.find(
      (m) => m.node.namespace === "projektstocksyncparentmaster" && m.node.key === "parentmaster"
    );
    
    if (parentMasterField?.node?.value) {
      console.log("✅ This variant is designated as CHILD.");
      let masterVariantId;
      
      try {
        // The parentmaster field should contain the master variant ID
        const parsedValue = JSON.parse(parentMasterField.node.value);
        masterVariantId = Array.isArray(parsedValue) && parsedValue.length > 0 ? parsedValue[0] : null;
      } catch (err) {
        console.error("❌ Error parsing 'parentmaster' metafield =>", err);
        return null;
      }
      
      if (!masterVariantId) {
        console.log("❌ No valid master variant ID found in 'parentmaster' metafield.");
        return null;
      }
      
      // Get the master's inventory item ID
      const masterInventoryItemId = await getInventoryItemIdFromVariantIdCached(
        shopDomain, 
        adminHeaders, 
        masterVariantId
      );
      
      if (!masterInventoryItemId) {
        console.error("❌ Could not find inventory item for master variant:", masterVariantId);
        return null;
      }
      
      result = {
        isChild: true,
        childVariantId: variantNode.id,
        childSku: variantNode.sku || '',
        masterVariantId: masterVariantId,
        masterInventoryItemId: masterInventoryItemId,
        inventoryItemId,
      };
    } else {
      console.log("❌ No MASTER/CHILD relationship detected for this variant.");
    }
  }

  if (result) {
    // Cache this result for 5 minutes
    setCacheValue(metafieldCache, cacheKey, result, 5 * 60 * 1000);
  }

  return result;
}

/*
 * ------------------------------------------------------------------
 * 4.1) GET THE "qtymanagement" (CHILD DIVISOR)
 * ------------------------------------------------------------------
 * childDivisor=1 => the child quantity always matches the MASTER.
 */
async function getVariantQtyManagement(shopDomain, adminHeaders, variantId) {
  const cacheKey = `${shopDomain}:qm:${variantId}`;
  const cachedValue = getCacheValue(qtyManagementCache, cacheKey);
  
  if (cachedValue !== null) {
    return cachedValue;
  }
  
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
  const result = valStr ? parseInt(valStr, 10) : 1;
  
  // Cache for 5 minutes as this value rarely changes
  setCacheValue(qtyManagementCache, cacheKey, result, 5 * 60 * 1000);
  
  return result;
}

/*
 * ------------------------------------------------------------------
 * 4.2) GET CHILDREN (inventoryItemId) OF A MASTER
 * ------------------------------------------------------------------
 * OPTIMISED VERSION: Uses the 'childrenkey' metafield directly
 * without searching through all products.
 */
async function getChildrenInventoryItems(shopDomain, adminHeaders, masterVariantId) {
  const cacheKey = `${shopDomain}:children:${masterVariantId}`;
  const cachedValue = getCacheValue(childrenCache, cacheKey);
  
  if (cachedValue !== null) {
    console.log(`✅ Retrieved ${cachedValue.length} children from cache for ${masterVariantId}`);
    return cachedValue;
  }
  
  const query = `
    query GetProductVariant($variantId: ID!) {
      productVariant(id: $variantId) {
        id
        metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
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

  // Normalise them by removing the Shopify GID prefix, if present
  const normChildIds = childIds.map((cid) =>
    cid.startsWith("gid://shopify/ProductVariant/")
      ? cid
      : `gid://shopify/ProductVariant/${cid}`
  );

  // Fetch all variants in a single query
  if (normChildIds.length === 0) {
    return [];
  }
  
  const batchQuery = `
    query GetBatchVariants($variantIds: [ID!]!) {
      nodes(ids: $variantIds) {
        ... on ProductVariant {
          id
          sku
          inventoryItem {
            id
          }
        }
      }
    }
  `;
  
  const batchResp = await fetch(
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
    {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: batchQuery,
        variables: { variantIds: normChildIds },
      }),
    }
  );
  
  const batchData = await batchResp.json();
  if (batchData.errors) {
    console.error("❌ Error fetching child variants =>", batchData.errors);
    return [];
  }
  
  const foundChildren = [];
  
  for (const node of batchData.data?.nodes || []) {
    if (node && node.inventoryItem?.id) {
      foundChildren.push({
        variantId: node.id,
        sku: node.sku || '',
        inventoryItemId: node.inventoryItem.id,
      });
    } else {
      console.warn(`⚠️ Missing inventoryItem for => ${node?.id}`);
    }
  }
  
  console.log(`✅ Final children => MASTER: found ${foundChildren.length} children`);
  
  // Cache the result for 10 minutes
  setCacheValue(childrenCache, cacheKey, foundChildren, 10 * 60 * 1000);
  
  return foundChildren;
}

/*
 * ------------------------------------------------------------------
 * 5) CONCURRENCY LOCK
 * ------------------------------------------------------------------
 * We set a lock (keyed by e.g. MASTER item ID + location) to avoid
 * running multiple overlapping updates.
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
 * We query the Inventory API for the 'available' quantity at the given
 * location. If not found, we attempt to activate the item in that location.
 */
async function getCurrentAvailableQuantity(shopDomain, adminHeaders, inventoryItemId, locationId) {
  // Check cache first
  const cacheKey = `${shopDomain}:qty:${inventoryItemId}:${locationId}`;
  // Short TTL for quantities since they change frequently
  const cachedQty = getCacheValue(metafieldCache, cacheKey);
  if (cachedQty !== null) {
    return cachedQty;
  }
  
  async function doQuery(iid, locId) {
    const query = `
      query getInventoryLevels($inventoryItemId: ID!) {
        inventoryItem(id: $inventoryItemId) {
          id
          inventoryLevels(first: 100) {
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
  if (qty !== null) {
    // Cache for a short time (15 seconds)
    setCacheValue(metafieldCache, cacheKey, qty, 15 * 1000);
    return qty;
  }

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
  
  // Cache for a short time after activation
  setCacheValue(metafieldCache, cacheKey, qty, 15 * 1000);
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
        sku
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
 * CACHED VERSION OF getInventoryItemIdFromVariantId
 * ------------------------------------------------------------------
 */
async function getInventoryItemIdFromVariantIdCached(shopDomain, adminHeaders, variantId) {
  const cacheKey = `${shopDomain}:varInv:${variantId}`;
  const cachedValue = getCacheValue(variantInventoryCache, cacheKey);
  
  if (cachedValue !== null) {
    return cachedValue;
  }
  
  const result = await getInventoryItemIdFromVariantId(shopDomain, adminHeaders, variantId);
  
  if (result) {
    // Cache for 60 minutes since variant-inventory relationship rarely changes
    setCacheValue(variantInventoryCache, cacheKey, result, 60 * 60 * 1000);
  }
  
  return result;
}

/*
 * ------------------------------------------------------------------
 * 7) LISTENING WINDOW IMPLEMENTATION (5 seconds)
 * ------------------------------------------------------------------
 * We collect multiple events for the same MASTER combo and process
 * them in a single pass.
 */
const aggregatorMap = new Map(); // comboKey => { events: [...], timer }

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

  // We pick the last event for each child and optionally one final MASTER event
  const finalChildMap = new Map();
  let finalMaster = null;

  for (const ev of events) {
    if (ev.isMaster) {
      finalMaster = ev; // Overwrite if multiple MASTER updates
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

  // Then the MASTER
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
 * Optimised version with batch updates
 */
async function handleChildEvent(ev) {
  console.log(
    `handleChildEvent => childVariant:${ev.childVariantId}, oldQty:${ev.oldQty}, newQty:${ev.newQty}`
  );
  const { shopDomain, adminHeaders } = ev;

  const childDiff = ev.newQty - ev.oldQty;

  // Determine the child's qtymanagement setting
  const childDivisor = await getVariantQtyManagement(shopDomain, adminHeaders, ev.childVariantId);
  console.log(`childDivisor => ${childDivisor}`);

  // Retrieve the MASTER's old quantity
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

  // Array for batch updates
  const batchUpdates = [];
  
  // 1) First add the CHILD that initiated this event
  batchUpdates.push({
    inventoryItemId: ev.inventoryItemId,
    locationId: ev.locationId,
    quantity: ev.newQty
  });

  // 2) If MASTER's qty has changed, add it to the batch
  let masterNeedsUpdate = newMasterQty !== masterOldQty;
  if (masterNeedsUpdate) {
    batchUpdates.push({
      inventoryItemId: ev.masterInventoryItemId,
      locationId: ev.locationId,
      quantity: newMasterQty
    });
  }

  // 3) Get all children for recalculation
  const siblings = await getChildrenInventoryItems(shopDomain, adminHeaders, ev.masterVariantId);
  
  // Set to track variants that have been updated
  const updatedVariants = new Set();
  updatedVariants.add(ev.childVariantId);
  if (masterNeedsUpdate) {
    updatedVariants.add(ev.masterVariantId);
  }

  // Calculate the final master quantity (might change after update)
  // Note: If the batch update already includes the master, we could use newMasterQty directly
  const finalMasterQty = masterNeedsUpdate ? 
    newMasterQty : 
    await getCurrentAvailableQuantity(
      shopDomain,
      adminHeaders,
      ev.masterInventoryItemId,
      ev.locationId
    );

  // Collect data from all siblings in parallel
  const siblingData = await Promise.all(
    siblings.map(async (sibling) => {
      const sid = sibling.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
      // Skip the child that triggered the event
      if (sid === String(ev.inventoryItemId)) {
        return null;
      }
      
      const sDivisor = await getVariantQtyManagement(shopDomain, adminHeaders, sibling.variantId);
      const oldSQty = await getCurrentAvailableQuantity(shopDomain, adminHeaders, sid, ev.locationId);
      
      let newSQty;
      if (sDivisor === 1) {
        // always match MASTER
        newSQty = finalMasterQty;
      } else {
        newSQty = Math.floor(finalMasterQty / (sDivisor || 1));
      }
      
      return {
        sibling,
        sid,
        oldSQty,
        newSQty,
        needsUpdate: newSQty !== oldSQty
      };
    })
  );

  // Add siblings that need updates to the batch
  for (const data of siblingData) {
    if (data && data.needsUpdate) {
      batchUpdates.push({
        inventoryItemId: data.sid,
        locationId: ev.locationId,
        quantity: data.newSQty
      });
      updatedVariants.add(data.sibling.variantId);
      console.log(`Sibling => old:${data.oldSQty}, new:${data.newSQty}`);
    }
  }

  // Perform the batch update of all inventories
  if (batchUpdates.length > 0) {
    await setInventoryQuantityBatch(shopDomain, adminHeaders, batchUpdates, true);
  }

  // 4) Update qtyold in parallel for all relevant variants
  const qtyOldUpdates = Array.from(updatedVariants).map(async (vid) => {
    let finalQty;
    
    if (vid === ev.childVariantId) {
      finalQty = ev.newQty;
    } else if (vid === ev.masterVariantId) {
      finalQty = newMasterQty;
    } else {
      // A sibling => retrieve final post-update
      const siblingInvId = await getInventoryItemIdFromVariantIdCached(shopDomain, adminHeaders, vid);
      if (!siblingInvId) return;
      
      const realQty = await getCurrentAvailableQuantity(
        shopDomain,
        adminHeaders,
        siblingInvId,
        ev.locationId
      );
      finalQty = realQty;
    }

    // Update oldQty in DB and Shopify in parallel
    return Promise.all([
      setQtyOldValueDB(shopDomain, vid, finalQty),
      setQtyOldValue(shopDomain, adminHeaders, vid, finalQty)
    ]);
  });

  // Wait for all qtyold updates to complete
  await Promise.all(qtyOldUpdates);
}

/**
 * MASTER => recalc children => if childDivisor=1 => child=MASTER,
 * else floor(MASTER / childDivisor)
 * Optimised version using batch updates
 */
async function handleMasterEvent(ev) {
  const { shopDomain, adminHeaders } = ev;
  console.log(`handleMasterEvent => oldQty:${ev.oldQty}, newQty:${ev.newQty}, sku:${ev.sku || 'N/A'}`);

  // Ensure MASTER's inventory is updated as expected
  const shopMasterQty = await getCurrentAvailableQuantity(
    shopDomain,
    adminHeaders,
    ev.inventoryItemId,
    ev.locationId
  );
  
  // Array for all inventory updates (master + children)
  const batchUpdates = [];
  const updatedVariants = new Set();
  updatedVariants.add(ev.variantId);
  
  // If master needs update, add to batch
  if (shopMasterQty !== ev.newQty) {
    batchUpdates.push({
      inventoryItemId: ev.inventoryItemId,
      locationId: ev.locationId,
      quantity: ev.newQty
    });
  }

  // Recalculate children's inventory
  const children = await getChildrenInventoryItems(shopDomain, adminHeaders, ev.variantId);
  let childrenData = [];

  // First collect all divisors and current quantities
  const childDivisors = await Promise.all(
    children.map(async (child) => {
      const cid = child.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
      const divisor = await getVariantQtyManagement(shopDomain, adminHeaders, child.variantId);
      const oldQty = await getCurrentAvailableQuantity(shopDomain, adminHeaders, cid, ev.locationId);
      
      return {
        child,
        cid,
        divisor,
        oldQty
      };
    })
  );

  // Now that we have all the information, process the changes
  for (const { child, cid, divisor, oldQty } of childDivisors) {
    let newCQty;
    if (divisor === 1) {
      newCQty = ev.newQty;
    } else {
      newCQty = Math.floor(ev.newQty / (divisor || 1));
    }

    if (newCQty !== oldQty) {
      batchUpdates.push({
        inventoryItemId: cid,
        locationId: ev.locationId,
        quantity: newCQty
      });
      updatedVariants.add(child.variantId);
    }
    
    // Add each CHILD to childrenData
    childrenData.push({
      variantId: child.variantId,
      sku: child.sku || '',
      oldQty: oldQty,
      newQty: newCQty,
    });
  }

  // Perform all inventory updates in one batch
  if (batchUpdates.length > 0) {
    await setInventoryQuantityBatch(
      shopDomain,
      adminHeaders,
      batchUpdates,
      true
    );
  }

  // Batch DB updates for 'qtyold' (using Promise.all for parallelism)
  const dbUpdatePromises = Array.from(updatedVariants).map(async (vId) => {
    let finalQty;
    if (vId === ev.variantId) {
      finalQty = ev.newQty;
    } else {
      const childInvId = await getInventoryItemIdFromVariantIdCached(shopDomain, adminHeaders, vId);
      if (!childInvId) return;
      finalQty = await getCurrentAvailableQuantity(
        shopDomain,
        adminHeaders,
        childInvId,
        ev.locationId
      );
    }
    
    // Update DB and metafield in parallel
    await Promise.all([
      setQtyOldValueDB(shopDomain, vId, finalQty),
      setQtyOldValue(shopDomain, adminHeaders, vId, finalQty)
    ]);
  });
  
  // Wait for all DB updates to complete
  await Promise.all(dbUpdatePromises);

  // Send the webhook with final data
  console.log("🚀 Calling sendCustomWebhook...");
  await sendCustomWebhook(
    shopDomain,
    { variantId: ev.variantId, sku: ev.sku || '', oldQty: ev.oldQty, newQty: ev.newQty },
    childrenData
  );
  console.log("📬 sendCustomWebhook function executed.");
}

async function sendCustomWebhook(shopDomain, masterData, childrenData) {
  try {
    console.log(`🔍 Retrieving customApiUrl for shop: ${shopDomain}`);

    const subscription = await prisma.shopSubscription.findUnique({
      where: { shop: shopDomain },
    });

    if (!subscription || !subscription.customApiUrl) {
      console.warn(`⚠️ No customApiUrl found for shop: ${shopDomain}, skipping webhook.`);
      return;
    }

    const webhookUrl = subscription.customApiUrl;
    console.log(`📡 Sending webhook to: ${webhookUrl}`);

    // JSON webhook structure
    const payload = {
      masterID: masterData.variantId,
      masterSKU: masterData.sku,
      "master old inventory": masterData.oldQty,
      "master new inventory": masterData.newQty,
      Modified: true,
      children: childrenData.map((child) => ({
        "child ID": child.variantId,
        "child SKU": child.sku,
        "child old inventory": child.oldQty,
        "child new inventory": child.newQty,
        Modified: true,
      })),
    };

    console.log(`📦 Webhook Payload:`, JSON.stringify(payload, null, 2));

    // Configure an HTTPS agent that forces IPv4 and maintains an active connection
    const agent = new https.Agent({
      keepAlive: true,
      family: 4, // Force use of IPv4
    });

    // Send webhook using axios with configured timeout
    const response = await axios.post(webhookUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 20000, // 20 second timeout
      httpsAgent: agent,
    });

    console.log(`📨 Webhook response status: ${response.status}`);

    if (response.status < 200 || response.status >= 300) {
      console.error(`❌ Failed to send custom webhook. Status: ${response.status}, Response: ${response.data}`);
    } else {
      console.log(`✅ Custom webhook sent successfully to ${webhookUrl}`);
    }
  } catch (error) {
    console.error("❌ Error sending custom webhook:", error.message);
  }
}

/*
 * ------------------------------------------------------------------
 * 8) MAIN WEBHOOK HANDLER
 * ------------------------------------------------------------------
 * This 'action' function responds to POST requests from Shopify.
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
    return new Response("Unauthorised", { status: 401 });
  }
  const isValid = verifyHmac(rawBody, hmacHeader, secret);
  if (!isValid) {
    console.error("Invalid HMAC => not from Shopify => aborting.");
    return new Response("Unauthorised", { status: 401 });
  }
  console.log("✅ HMAC verified successfully.");

  // 3) Check active subscription
  const shopDomain = request.headers.get("X-Shopify-Shop-Domain");
  if (!shopDomain) {
    console.error("No X-Shopify-Shop-Domain header => cannot retrieve tokens");
    return new Response("Shop domain missing", { status: 400 });
  }

  // Check subscription status in the database
  const subscription = await prisma.shopSubscription.findUnique({
    where: { shop: shopDomain }
  });

  if (!subscription || subscription.plan !== "PAID" || subscription.status !== "ACTIVE") {
    console.log(`⛔ Ignored Webhook - Plan: ${subscription?.plan}, Status: ${subscription?.status}`);
    return new Response("Skipped - Subscription not active", { status: 200 });
  }

  // 4) Short-term dedup => 10 seconds
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

  // 7) Retrieve admin headers from DB
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
    console.log("No MASTER/CHILD relationship found; performing a direct update.");

    // If no relationship, just set the quantity directly in Shopify
    await setInventoryQuantity(shopDomain, adminHeaders, inventoryItemId, locationId, newQty);

    // Also store the new qty as oldQty in the DB for future reference,
    // but we need a variant ID to do that. We'll try a quick fallback:
    const fallbackVariantId = await fetch(
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
              variant {
                id
              }
            }
          }`,
          variables: { inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}` },
        }),
      }
    )
      .then((res) => res.json())
      .then((resData) => resData?.data?.inventoryItem?.variant?.id)
      .catch(() => null);

    if (fallbackVariantId) {
      await setQtyOldValueDB(shopDomain, fallbackVariantId, newQty);
      await setQtyOldValue(shopDomain, adminHeaders, fallbackVariantId, newQty);
    } else {
      console.log("Could not determine variantId for direct update, skipping DB 'oldQty' storage.");
    }

    return new Response("No Master/Child => performed a direct update", { status: 200 });
  }

  // If we do have MASTER or CHILD info, handle aggregator logic
  let variantId;
  let isMaster = false;

  let sku = '';
  if (info.isMaster) {
    isMaster = true;
    variantId = info.variantId;
    sku = info.sku;
  } else {
    isMaster = false;
    variantId = info.childVariantId;
    sku = info.childSku;
  }

  // 9) Retrieve oldQty from DB instead of from Shopify
  const oldQty = await getQtyOldValueDB(shopDomain, variantId);
  console.log(`(DB-based oldQty) => old:${oldQty}, new:${newQty}`);

  // aggregator key => MASTER item + location
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
    sku,
  };

  if (info.isChild) {
    // CHILD
    eventObj.masterInventoryItemId = info.masterInventoryItemId;
    eventObj.masterVariantId = info.masterVariantId;
    eventObj.childVariantId = info.childVariantId;
    eventObj.inventoryItemId = info.inventoryItemId; // child's inventory item
  } else {
    // MASTER
    eventObj.variantId = info.variantId;
    eventObj.inventoryItemId = info.inventoryItemId;
  }

  // 10) Enqueue for aggregator processing
  addEventToAggregator(comboKey, eventObj);

  return new Response("Event queued => waiting for aggregator to finalise", { status: 200 });
};