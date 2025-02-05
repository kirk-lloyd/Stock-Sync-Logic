import { json } from "@remix-run/node";
import crypto from "crypto";

// ------------------------------------------------------------------
// 1) Verificar firma HMAC
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
// 2) Mutación para "activar" un inventoryItem en una ubicación
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
// 3) Mutación para actualizar inventario con inventorySetQuantities
// ------------------------------------------------------------------
async function setInventoryQuantity(adminHeaders, inventoryItemId, locationId, quantity) {
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
            name: "available",         // "available" o "on_hand"
            reason: "correction",     // un valor válido ("correction", "restock", etc.)
            ignoreCompareQuantity: true,
            quantities: [
              {
                inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
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
  return data;
}

// ------------------------------------------------------------------
// 4) Funciones para determinar si un item es master o child
//    usando Metafields en la Variant
// ------------------------------------------------------------------

/**
 * Dado un inventoryItemId, encontramos el variant asociado y:
 *  - Revisamos si es MASTER (metafield: "master" = "true").
 *  - Si no es master, buscamos en el PRODUCT la variante que SÍ sea master
 *    y que en su `childrenkey` contenga ESTE variant ID.
 *
 * Retorna:
 *   { isChild: true, masterVariantId: "...", masterInventoryItemId: "..." } si es un child
 *   { isMaster: true, variantId: "...", inventoryItemId: "..." } si es un master
 *   (o null si no se encuentra nada)
 */
async function getMasterChildInfo(adminHeaders, inventoryItemId) {
  // 1) Encontrar la "Variant" asociada a este inventoryItem
  const query = `
    query getVariantByInventory($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        id
        variant {
          id
          product {
            id
            variants(first: 100) {
              edges {
                node {
                  id
                  inventoryItem {
                    id
                  }
                  # master field
                  metafield(namespace: "projektstocksyncmaster", key: "master") {
                    id
                    value
                  }
                  # children array
                  metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
                    id
                    value
                  }
                }
              }
            }
          }
          # Acceso directo a la propia variant
          metafield(namespace: "projektstocksyncmaster", key: "master") {
            value
          }
          metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
            value
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
        variables: {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
        },
      }),
    }
  );

  const data = await response.json();
  const variantNode = data?.data?.inventoryItem?.variant;
  if (!variantNode) {
    // No hay variant => no existe. Devuelve null
    return null;
  }

  // 2) ¿Esta variant es MASTER?
  const isMasterValue = variantNode?.metafield?.value; // "true" o "false"
  const isMaster = (isMasterValue === "true");

  // Prepara info base
  const thisVariantId = variantNode.id; // "gid://shopify/ProductVariant/123"
  const thisInventoryItemId = inventoryItemId;

  if (isMaster) {
    // => Si es MASTER, no necesitamos buscar más
    return {
      isMaster: true,
      variantId: thisVariantId,
      inventoryItemId: thisInventoryItemId,
    };
  }

  // => Si NO es master, es child. Pero necesitamos saber QUIÉN es su master:
  // Recorremos las variants de su product, buscamos la que:
  //   - Tenga metafield "master" = "true"
  //   - Su "childrenkey" incluya `thisVariantId`
  const allVariantEdges = variantNode?.product?.variants?.edges || [];
  for (const edge of allVariantEdges) {
    const possibleMaster = edge.node;
    const masterFieldValue = possibleMaster?.metafield?.value; // "true" or "false"
    if (masterFieldValue === "true") {
      // Parseamos su childrenkey
      let childrenIds = [];
      try {
        const raw = possibleMaster?.metafield?.value; // JSON
        childrenIds = JSON.parse(raw); // ["gid://shopify/ProductVariant/456", ...]
      } catch (err) {
        // no es JSON válido => skip
      }
      // Si childrenIds incluye "thisVariantId", lo hallamos
      if (childrenIds.includes(thisVariantId)) {
        // Retornamos la info del master
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

  // Si llegamos aquí, no encontramos un master con este child => no hay relación => null
  return null;
}

/**
 * Obtiene la lista de *InventoryItem IDs* de todos los children
 * de un variant que es MASTER.
 * 
 * 1) Leemos su metafield "childrenkey" => array de VARIANT IDs
 * 2) Convertimos cada "Variant ID" => su "InventoryItem ID"
 */
async function getChildrenInventoryItems(adminHeaders, masterVariantId) {
  // 1) Buscar la variant MASTER
  const query = `
    query getMasterVariant($id: ID!) {
      productVariant(id: $id) {
        id
        metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
          value
        }
        # Para luego mapear child variant -> inventoryItem
        product {
          variants(first: 100) {
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
        variables: { id: masterVariantId },
      }),
    }
  );
  const data = await response.json();
  const varNode = data?.data?.productVariant;
  if (!varNode) {
    return [];
  }

  // 2) Parse children IDs (Variant IDs)
  let childVariantIds = [];
  if (varNode?.metafield?.value) {
    try {
      childVariantIds = JSON.parse(varNode.metafield.value);
    } catch (err) {
      console.error("Error parsing childrenkey from master:", err);
    }
  }

  // 3) Convert each child variant ID => inventoryItem ID
  const allVariantEdges = varNode?.product?.variants?.edges || [];
  const childInventoryItemIds = [];

  // EJ: childVariantIds = ["gid://shopify/ProductVariant/333", ...]
  childVariantIds.forEach((childVarId) => {
    // buscar en allVariantEdges => si coincide con node.id => node.inventoryItem.id
    const childEdge = allVariantEdges.find((edge) => edge.node.id === childVarId);
    if (childEdge && childEdge.node.inventoryItem?.id) {
      // "gid://shopify/InventoryItem/4783768..."
      const numeric = childEdge.node.inventoryItem.id.split("/").pop();
      childInventoryItemIds.push(numeric);
    }
  });

  return childInventoryItemIds;
}

// ------------------------------------------------------------------
// 5) Webhook principal
// ------------------------------------------------------------------
export const action = async ({ request }) => {
  console.log("Received webhook request for inventory update.");

  // 1. Verificar HMAC
  const secret = process.env.WEBHOOK_SECRET;
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

  // 2. Parsear
  const payload = JSON.parse(rawBody);
  console.log("Parsed webhook payload:", payload);

  // 3. Autenticar
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

  // 4. Extraer datos
  const inventoryItemId = payload.inventory_item_id; // number
  const newQuantity = payload.available;
  const locationId = payload.location_id; // number

  console.log("Formatted Inventory Item ID:", `gid://shopify/InventoryItem/${inventoryItemId}`);
  console.log("Formatted Location ID:", `gid://shopify/Location/${locationId}`);

  // 5. Verificar que existe en la ubicación (si no, activarlo)
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
    console.log("Checking if inventory item exists/active in location...");
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
      // Ver si ya está activo
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

  // 6. Actualizar este item
  console.log(`Updating quantity of ${inventoryItemId} to ${newQuantity}...`);
  try {
    const selfUpdate = await setInventoryQuantity(admin.headers, inventoryItemId, locationId, newQuantity);
    console.log("Self item update response =>", JSON.stringify(selfUpdate, null, 2));
  } catch (err) {
    console.error("Error updating inventory from webhook:", err);
    return json({ error: err.message }, { status: 400 });
  }

  // 7. Lógica MASTER-CHILD (bidireccional)
  console.log("Determining if item is child or master...");
  try {
    const info = await getMasterChildInfo(admin.headers, inventoryItemId);

    if (!info) {
      // No se encontró ni master ni child => no hay relaciones
      console.log("No master-child info found => done.");
      return json({ message: "No master/child relationship. Update done." });
    }

    if (info.isChild) {
      // => es CHILD. Actualizamos su MASTER y luego todos los children
      console.log(`Item ${inventoryItemId} is CHILD => Master = ${info.masterInventoryItemId}`);

      if (!info.masterInventoryItemId) {
        console.log("Master inventoryItemId not found => skipping update");
        return json({ message: "Child updated, but no master ID found." });
      }

      // 7.1. Actualizar el master
      console.log(`Updating MASTER ${info.masterInventoryItemId} => quantity ${newQuantity}`);
      const masterUpdate = await setInventoryQuantity(
        admin.headers,
        info.masterInventoryItemId,
        locationId,
        newQuantity
      );
      console.log("Master update =>", JSON.stringify(masterUpdate, null, 2));

      // 7.2. Obtener children del master => actualizarlos
      console.log("Fetching siblings from master's 'childrenkey'...");
      const siblings = await getChildrenInventoryItems(admin.headers, info.masterVariantId);
      console.log("Siblings found =>", siblings);

      for (const childInventoryId of siblings) {
        // Evita re-actualizar el child que disparó el webhook
        if (Number(childInventoryId) === Number(inventoryItemId)) {
          console.log("Skipping the same child =>", childInventoryId);
          continue;
        }
        console.log(`Updating sibling ${childInventoryId} => ${newQuantity}`);
        const siblingUpdate = await setInventoryQuantity(
          admin.headers,
          childInventoryId,
          locationId,
          newQuantity
        );
        console.log("Sibling update =>", JSON.stringify(siblingUpdate, null, 2));
      }
    } else if (info.isMaster) {
      // => es MASTER. Actualizamos sus children
      console.log(`Item ${inventoryItemId} is MASTER => updating children...`);

      // 7.3. Obtener su childrenkey => actualizamos todos
      const childInvIds = await getChildrenInventoryItems(admin.headers, info.variantId);
      console.log("Children =>", childInvIds);

      for (const childId of childInvIds) {
        console.log(`Updating child ${childId} => ${newQuantity}`);
        const update = await setInventoryQuantity(
          admin.headers,
          childId,
          locationId,
          newQuantity
        );
        console.log("Child update =>", JSON.stringify(update, null, 2));
      }
    }

    return json({ message: "Inventory updated (master-child sync complete)." });
  } catch (err) {
    console.error("Error in master-child sync logic:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
