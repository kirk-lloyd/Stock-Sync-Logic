/************************************************************************
 * webhooks.inventory-update.server.js
 * 
 * This file contains all of the server-only logic required by our 
 * inventory-update webhook. By placing code that references Node modules,
 * Prisma, crypto, etc., into this file, we ensure it is only invoked by 
 * server-side contexts (like Remix loaders or actions), thereby avoiding 
 * client bundling issues.
 ************************************************************************/
import crypto from "crypto";
import https from "https";
import axios from "axios";
import prisma from "../db.server.js"; // This remains a server import (fine here)

/************************************************************************
 * 0) SHORT-TERM DEDUPLICATION (10s FOR EXACT PAYLOAD)
 * We store a key in a Map for 10 seconds to prevent re-processing the 
 * exact same payload within that short window.
 ************************************************************************/
const recentlyProcessedExact = new Map();

export function markExactKey(key) {
  recentlyProcessedExact.set(key, Date.now());
  setTimeout(() => {
    recentlyProcessedExact.delete(key);
  }, 10000);
}

export function hasExactKey(key) {
  return recentlyProcessedExact.has(key);
}

export function buildExactDedupKey(payload) {
  const { inventory_item_id, location_id, available, updated_at } = payload;
  return `${inventory_item_id}-${location_id}-${available}-${updated_at}`;
}

/************************************************************************
 * 0.1) 6-SECOND LOCK FOR (INVENTORY_ITEM + LOCATION)
 * Used to prevent collisions and re-entries that may cause concurrency 
 * problems.
 ************************************************************************/
const recentlyTouched = new Map();

export function markComboKey(key) {
  recentlyTouched.set(key, Date.now());
  setTimeout(() => {
    recentlyTouched.delete(key);
  }, 6000);
}

export function hasComboKey(key) {
  return recentlyTouched.has(key);
}

/************************************************************************
 * 0.2) PREDICTED (FUTURE) UPDATES MAP
 * If we update Shopify programmatically, we mark that update as predicted 
 * so we can skip processing the subsequent Shopify webhook echo.
 ************************************************************************/
const predictedUpdates = new Map();

export function buildPredictedKey(inventoryItemId, locationId, newQty) {
  return `${inventoryItemId}-${locationId}-${newQty}`;
}

export function markPredictedUpdate(pKey) {
  predictedUpdates.set(pKey, Date.now());
  setTimeout(() => {
    predictedUpdates.delete(pKey);
  }, 10000);
}

export function hasPredictedUpdate(pKey) {
  return predictedUpdates.has(pKey);
}

/************************************************************************
 * SIMPLE CACHE IMPLEMENTATION
 * We cache certain seldom-changing data (metafields, variant relationships, 
 * etc.) to reduce redundant API calls and improve performance.
 ************************************************************************/
const metafieldCache = new Map();
const variantInventoryCache = new Map();
const qtyManagementCache = new Map();
const childrenCache = new Map();

export function setCacheValue(cache, key, value, ttlMs = 60000) {
  cache.set(key, { value, expiry: Date.now() + ttlMs });
  setTimeout(() => {
    const entry = cache.get(key);
    if (entry && entry.expiry <= Date.now()) {
      cache.delete(key);
    }
  }, ttlMs);
}

export function getCacheValue(cache, key) {
  // In this example, we force a 'null' return to skip using cache 
  // but the logic is intact if you wish to re-enable caching.
  return null;
}

export function invalidateRelationshipCaches(shopDomain, variantId) {
  const cacheKey = `${shopDomain}:${variantId}`;
  childrenCache.delete(cacheKey);
  metafieldCache.delete(cacheKey);
  console.log(`🧹 Cache invalidated for ${cacheKey}`);
}

/************************************************************************
 * 1) HMAC VERIFICATION
 * We verify the X-Shopify-Hmac-Sha256 header to ensure the webhook is 
 * genuinely from Shopify.
 ************************************************************************/
export function verifyHmac(body, hmacHeader, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

/************************************************************************
 * UTILITY: Retrieve Admin Headers and GraphQL URL for a Given Shop
 * We'll look up session details (like the Shopify admin token) in Prisma.
 ************************************************************************/
export async function getShopSessionHeaders(shopDomain) {
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

/************************************************************************
 * 2) ACTIVATE AN INVENTORY ITEM IN A LOCATION (IF NOT ACTIVE)
 ************************************************************************/
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

export async function activateInventoryItem(shopDomain, adminHeaders, inventoryItemId, locationId) {
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

/************************************************************************
 * 3) SET INVENTORY QUANTITY (SINGLE)
 * This function updates on_hand (available) inventory in Shopify.
 ************************************************************************/
export function buildPredictedKeyForInternalUpdate(
  inventoryItemId,
  locationId,
  quantity
) {
  return `${inventoryItemId}-${locationId}-${quantity}`;
}

export async function setInventoryQuantity(
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


  // Mark as predicted update
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

/************************************************************************
 * 3.0) SET INVENTORY QUANTITY (BATCH)
 * Updates multiple inventory levels in a single API call. 
 ************************************************************************/
export async function setInventoryQuantityBatch(
  shopDomain,
  adminHeaders,
  itemsToUpdate,
  internal = false
) {
  if (!itemsToUpdate.length) return null;

  const MY_APP_URL = process.env.MY_APP_URL || "https://your-app-url.com";
  const referenceDocumentUriValue = internal
    ? `${MY_APP_URL}/by_app/internal-batch-update`
    : `${MY_APP_URL}/by_app/external-batch-update`;

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

/************************************************************************
 * 3.1) GET/SET 'qtyold' IN SHOPIFY (for reference only)
 ************************************************************************/
export async function getQtyOldValue(shopDomain, adminHeaders, variantId) {
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

export async function setQtyOldValue(shopDomain, adminHeaders, variantId, newQty) {
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

/************************************************************************
 * OPTIMISED => BATCH UPDATE MULTIPLE METAFIELDS AT ONCE
 ************************************************************************/
export async function batchUpdateMetafields(shopDomain, adminHeaders, updates) {
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

export async function setQtyOldValueBatch(shopDomain, adminHeaders, updates) {
  const metafieldUpdates = updates.map(update => ({
    ownerId: update.variantId,
    namespace: "projektstocksyncqtyold",
    key: "qtyold",
    type: "number_integer",
    value: String(update.newQty)
  }));
  
  return batchUpdateMetafields(shopDomain, adminHeaders, metafieldUpdates);
}

/************************************************************************
 * 3.2) GET/SET QTYOLD FROM PRISMA DB
 * We rely on 'oldQuantity' in the Stockdb table as our genuine source 
 * of "previous" quantity data.
 ************************************************************************/
function normaliseVariantId(variantId) {
  if (!variantId) return null;
  return variantId.replace("gid://shopify/ProductVariant/", "");
}

export async function getQtyOldValueDB(shopDomain, variantId) {
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

export async function setQtyOldValueDB(shopDomain, variantId, newQty) {
  const normalisedId = normaliseVariantId(variantId);

  await prisma.stockdb.upsert({
    where: {
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

export async function setQtyOldValueDBBatch(shopDomain, updates) {
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
  
  const results = await prisma.$transaction(dbOperations);
  console.log(`✅ Updated ${results.length} oldQuantity entries in DB`);
  return results;
}

/************************************************************************
 * 4) DETERMINE IF THIS ITEM IS MASTER OR CHILD
 * We examine the relevant metafields on the variant to see if it is a 
 * MASTER, a CHILD, or neither.
 ************************************************************************/
export async function getMasterChildInfo(shopDomain, adminHeaders, inventoryItemId) {
  console.log(`🔍 getMasterChildInfo => inventory item: ${inventoryItemId}`);

  const cacheKey = `${shopDomain}:inv:${inventoryItemId}`;
  const cachedInfo = getCacheValue(metafieldCache, cacheKey);
  if (cachedInfo !== null) {
    console.log("✅ Retrieved MASTER/CHILD info from cache");
    return cachedInfo;
  }

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
    const parentMasterField = metafields.find(
      (m) => m.node.namespace === "projektstocksyncparentmaster" && m.node.key === "parentmaster"
    );
    if (parentMasterField?.node?.value) {
      console.log("✅ This variant is designated as CHILD.");
      let masterVariantId;
      try {
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
    setCacheValue(metafieldCache, cacheKey, result, 5 * 60 * 1000);
  }
  return result;
}

/************************************************************************
 * 4.1) GET "qtymanagement" FOR A VARIANT
 * If qtymanagement = 1, the child’s quantity is forced to match the MASTER.
 ************************************************************************/
export async function getVariantQtyManagement(shopDomain, adminHeaders, variantId) {
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
  
  setCacheValue(qtyManagementCache, cacheKey, result, 5 * 60 * 1000);
  return result;
}

/************************************************************************
 * 4.2) GET CHILDREN (inventoryItemId) OF A MASTER
 ************************************************************************/
export async function getChildrenInventoryItems(shopDomain, adminHeaders, masterVariantId) {
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

  const normChildIds = childIds.map((cid) =>
    cid.startsWith("gid://shopify/ProductVariant/")
      ? cid
      : `gid://shopify/ProductVariant/${cid}`
  );

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
  
  setCacheValue(childrenCache, cacheKey, foundChildren, 10 * 60 * 1000);
  return foundChildren;
}

/************************************************************************
 * 5) CONCURRENCY LOCK
 * We set a concurrency lock keyed by e.g. MASTER item + location 
 * to avoid multiple overlapping updates.
 ************************************************************************/
const updateLocks = new Map();

export async function processWithDeferred(key, initialUpdate, processUpdate) {
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

/************************************************************************
 * 6) GET CURRENT "available" QUANTITY
 * We query the Inventory API for the 'available' quantity. If not found, 
 * we attempt to activate the item in that location and try again.
 ************************************************************************/
export async function getCurrentAvailableQuantity(shopDomain, adminHeaders, inventoryItemId, locationId) {
  const cacheKey = `${shopDomain}:qty:${inventoryItemId}:${locationId}`;
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
    setCacheValue(metafieldCache, cacheKey, qty, 15000);
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
  setCacheValue(metafieldCache, cacheKey, qty, 15000);
  return qty;
}

/************************************************************************
 * HELPER => GET INVENTORY ITEM ID FROM A VARIANT ID
 ************************************************************************/
export async function getInventoryItemIdFromVariantId(shopDomain, adminHeaders, variantId) {
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

/************************************************************************
 * CACHED VERSION
 ************************************************************************/
export async function getInventoryItemIdFromVariantIdCached(shopDomain, adminHeaders, variantId) {
  const cacheKey = `${shopDomain}:varInv:${variantId}`;
  const cachedValue = getCacheValue(variantInventoryCache, cacheKey);
  if (cachedValue !== null) {
    return cachedValue;
  }
  
  const result = await getInventoryItemIdFromVariantId(shopDomain, adminHeaders, variantId);
  if (result) {
    setCacheValue(variantInventoryCache, cacheKey, result, 60 * 60 * 1000);
  }
  return result;
}

/************************************************************************
 * 7) 5-SECOND "LISTENING WINDOW" AGGREGATOR
 * We group multiple near-simultaneous updates for the same MASTER combo 
 * into a single handling pass, preventing collisions.
 ************************************************************************/
const aggregatorMap = new Map();

export function addEventToAggregator(comboKey, event) {
  if (aggregatorMap.has(comboKey)) {
    const aggregator = aggregatorMap.get(comboKey);
    aggregator.events.push(event);
  } else {
    const aggregator = { events: [event], timer: null };
    aggregatorMap.set(comboKey, aggregator);
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

  events.forEach(ev => {
    if (!ev.isMaster && ev.oldQty === ev.newQty) {
      console.log(
        `⚠️ Possible modal-initiated event detected for child ${ev.childVariantId}: ` +
        `oldQty (${ev.oldQty}) = newQty (${ev.newQty}).`
      );
    }
    if (ev.isMaster && Math.abs(ev.newQty - ev.oldQty) < 2) {
      console.log(
        `⚠️ Small quantity change for master ${ev.variantId}: oldQty (${ev.oldQty}) → newQty (${ev.newQty}).`
      );
    }
  });

  const finalChildMap = new Map();
  let finalMaster = null;

  for (const ev of events) {
    if (ev.isMaster) {
      finalMaster = ev;
    } else {
      finalChildMap.set(ev.childVariantId, ev);
    }
  }

  for (const [childVarId, ev] of finalChildMap) {
    try {
      await handleChildEvent(ev);
    } catch (err) {
      console.error("handleChildEvent => error =>", err);
    }
  }

  if (finalMaster) {
    try {
      await handleMasterEvent(finalMaster);
    } catch (err) {
      console.error("handleMasterEvent => error =>", err);
    }
  }

  console.log(`✅ Aggregator processing complete => combo:${comboKey}`);
}

/************************************************************************
 * CHILD EVENT HANDLER
 * We do difference-based logic: newMaster = masterOld + (childDiff * childDivisor).
 * Then recalc siblings. If childDivisor=1 => child's quantity matches MASTER.
 ************************************************************************/
async function handleChildEvent(ev) {
  console.log(
    `handleChildEvent => childVariant:${ev.childVariantId}, oldQty:${ev.oldQty}, newQty:${ev.newQty}`
  );
  const { shopDomain, adminHeaders } = ev;

  const childDivisor = await getVariantQtyManagement(shopDomain, adminHeaders, ev.childVariantId);
  console.log(`childDivisor => ${childDivisor}`);

  const masterCurrentQty = await getCurrentAvailableQuantity(
    shopDomain,
    adminHeaders,
    ev.masterInventoryItemId,
    ev.locationId
  );
  console.log(`masterCurrentQty => ${masterCurrentQty}`);

  let expectedChildQty;
  if (childDivisor === 1) {
    expectedChildQty = masterCurrentQty;
  } else {
    expectedChildQty = Math.floor(masterCurrentQty / (childDivisor || 1));
  }
  console.log(`expectedChildQty => ${expectedChildQty}, actualNewQty => ${ev.newQty}`);

  if (expectedChildQty === ev.newQty) {
    console.log(
      `🚩 Skipping webhook processing: Child quantity matches the expected value. ` +
      `Likely originated from the modal.`
    );
    await Promise.all([
      setQtyOldValueDB(shopDomain, ev.childVariantId, ev.newQty),
      setQtyOldValue(shopDomain, adminHeaders, ev.childVariantId, ev.newQty)
    ]);
    return;
  }

  const childDiff = ev.newQty - ev.oldQty;
  const masterOldQty = await getQtyOldValueDB(shopDomain, ev.masterVariantId) || masterCurrentQty;
  console.log(`masterOldQty (from DB) => ${masterOldQty}`);

  const scaledDiff = childDiff * childDivisor;
  const newMasterQty = masterOldQty + scaledDiff;
  console.log(`newMasterQty => ${newMasterQty}`);

  const batchUpdates = [];
  batchUpdates.push({
    inventoryItemId: ev.inventoryItemId,
    locationId: ev.locationId,
    quantity: ev.newQty
  });

  const masterNeedsUpdate = newMasterQty !== masterCurrentQty;
  if (masterNeedsUpdate) {
    batchUpdates.push({
      inventoryItemId: ev.masterInventoryItemId,
      locationId: ev.locationId,
      quantity: newMasterQty
    });
  }

  const siblings = await getChildrenInventoryItems(shopDomain, adminHeaders, ev.masterVariantId);
  const updatedVariants = new Set();
  updatedVariants.add(ev.childVariantId);
  if (masterNeedsUpdate) {
    updatedVariants.add(ev.masterVariantId);
  }

  const finalMasterQty = masterNeedsUpdate ? newMasterQty : masterCurrentQty;

  const siblingData = await Promise.all(
    siblings.map(async (sib) => {
      const sid = sib.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
      if (sid === String(ev.inventoryItemId)) {
        return null;
      }
      const sDivisor = await getVariantQtyManagement(shopDomain, adminHeaders, sib.variantId);
      const oldSQty = await getCurrentAvailableQuantity(shopDomain, adminHeaders, sid, ev.locationId);
      
      let newSQty;
      if (sDivisor === 1) {
        newSQty = finalMasterQty;
      } else {
        newSQty = Math.floor(finalMasterQty / (sDivisor || 1));
      }
      
      return {
        sibling: sib,
        sid,
        oldSQty,
        newSQty,
        needsUpdate: newSQty !== oldSQty
      };
    })
  );

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

  if (batchUpdates.length > 0) {
    await setInventoryQuantityBatch(shopDomain, adminHeaders, batchUpdates, true);
  }

  const qtyOldUpdates = Array.from(updatedVariants).map(async (vid) => {
    let finalQty;
    if (vid === ev.childVariantId) {
      finalQty = ev.newQty;
    } else if (vid === ev.masterVariantId) {
      finalQty = newMasterQty;
    } else {
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

    return Promise.all([
      setQtyOldValueDB(shopDomain, vid, finalQty),
      setQtyOldValue(shopDomain, adminHeaders, vid, finalQty)
    ]);
  });

  await Promise.all(qtyOldUpdates);
}

/************************************************************************
 * MASTER EVENT HANDLER
 * MASTER => recalc children => if childDivisor=1 => child=MASTER 
 * else child = floor(MASTER / childDivisor)
 ************************************************************************/
async function handleMasterEvent(ev) {
  const { shopDomain, adminHeaders } = ev;
  console.log(`handleMasterEvent => oldQty:${ev.oldQty}, newQty:${ev.newQty}, sku:${ev.sku || 'N/A'}`);

  const shopMasterQty = await getCurrentAvailableQuantity(
    shopDomain,
    adminHeaders,
    ev.inventoryItemId,
    ev.locationId
  );
  const storedOldQty = await getQtyOldValueDB(shopDomain, ev.variantId);

  const likelyFromUI = storedOldQty !== ev.oldQty && shopMasterQty === ev.newQty;
  if (likelyFromUI) {
    console.log(
      `🚩 Potential UI-initiated update => mismatch oldQty, but final matches newQty. ` +
      `Updating oldQty only, skipping child recalculation.`
    );
    await Promise.all([
      setQtyOldValueDB(shopDomain, ev.variantId, ev.newQty),
      setQtyOldValue(shopDomain, adminHeaders, ev.variantId, ev.newQty)
    ]);
    return;
  }
  
  const batchUpdates = [];
  const updatedVariants = new Set();
  updatedVariants.add(ev.variantId);

  if (shopMasterQty !== ev.newQty) {
    batchUpdates.push({
      inventoryItemId: ev.inventoryItemId,
      locationId: ev.locationId,
      quantity: ev.newQty
    });
  }

  const children = await getChildrenInventoryItems(shopDomain, adminHeaders, ev.variantId);
  let childrenData = [];

  const childDivisors = await Promise.all(
    children.map(async (child) => {
      const cid = child.inventoryItemId.replace("gid://shopify/InventoryItem/", "");
      const divisor = await getVariantQtyManagement(shopDomain, adminHeaders, child.variantId);
      const oldQty = await getCurrentAvailableQuantity(shopDomain, adminHeaders, cid, ev.locationId);
      return { child, cid, divisor, oldQty };
    })
  );

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
    childrenData.push({
      variantId: child.variantId,
      sku: child.sku || '',
      oldQty: oldQty,
      newQty: newCQty,
    });
  }

  if (batchUpdates.length > 0) {
    await setInventoryQuantityBatch(
      shopDomain,
      adminHeaders,
      batchUpdates,
      true
    );
  }

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
    await Promise.all([
      setQtyOldValueDB(shopDomain, vId, finalQty),
      setQtyOldValue(shopDomain, adminHeaders, vId, finalQty)
    ]);
  });

  await Promise.all(dbUpdatePromises);

  console.log("🚀 Calling sendCustomWebhook...");
  await sendCustomWebhook(
    shopDomain,
    { variantId: ev.variantId, sku: ev.sku || '', oldQty: ev.oldQty, newQty: ev.newQty },
    childrenData
  );
  console.log("📬 sendCustomWebhook function executed.");
}

/************************************************************************
 * 7.1) SEND CUSTOM WEBHOOK
 * We dispatch a JSON payload to the 'customApiUrl' the merchant has defined.
 ************************************************************************/
export async function sendCustomWebhook(shopDomain, masterData, childrenData) {
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

    const agent = new https.Agent({
      keepAlive: true,
      family: 4, 
    });

    const response = await axios.post(webhookUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 20000, // 20s
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
