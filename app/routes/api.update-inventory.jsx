import { json } from "@remix-run/node";
import crypto from "crypto";

/**
 * Helper to verify Shopify webhook HMAC signature.
 */
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

/**
 * GraphQL mutation to 'activate' (associate) an InventoryItem with a Location
 * in case Shopify says the item isn't active there.
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

/**
 * This function performs a delta-based inventory update using `inventoryAdjustQuantities`.
 * The `delta` can be positive (add units) or negative (remove units).
 */
async function adjustVariantInventory({ admin, inventoryItemId, locationId, delta }) {
  // Skip if no change in quantity
  if (!delta) return;

  const query = `
    mutation AdjustInventoryQuantities(
      $inventoryItemId: ID!
      $locationId: ID!
      $delta: Int!
    ) {
      inventoryAdjustQuantities(
        input: {
          reason: "correction"
          name: "available"
          changes: [
            {
              delta: $delta
              inventoryItemId: $inventoryItemId
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
    }
  `;

  const response = await fetch(
    "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...admin.headers,
      },
      body: JSON.stringify({
        query,
        variables: { inventoryItemId, locationId, delta },
      }),
    }
  );

  const data = await response.json();
  const userErrors = data?.data?.inventoryAdjustQuantities?.userErrors;
  if (userErrors && userErrors.length > 0) {
    throw new Error(
      "UserErrors from inventoryAdjustQuantities: " + JSON.stringify(userErrors)
    );
  }
}

/**
 * Helper query to find out if an InventoryItem is a master or child.
 * - If "projektstocksyncmaster/master" = "true" => master
 * - Otherwise, see if there's a variant in the same product that has it in childrenkey => child
 */
async function getMasterChildInfo(adminHeaders, inventoryItemId) {
  const query = `
    query getVariantByInventory($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        id
        variant {
          id
          inventoryQuantity
          metafield(namespace: "projektstocksyncmaster", key: "master") {
            value
          }
          metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
            value
          }
          product {
            variants(first: 50) {
              edges {
                node {
                  id
                  inventoryQuantity
                  inventoryItem {
                    id
                  }
                  metafield(namespace: "projektstocksyncmaster", key: "master") {
                    value
                  }
                  metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
                    value
                  }
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
        variables: {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
        },
      }),
    }
  );

  const data = await response.json();
  const variantNode = data?.data?.inventoryItem?.variant;
  if (!variantNode) {
    return null;
  }

  // Check if this variant is MASTER
  const isMaster = variantNode?.metafield?.value === "true";
  const thisVariantId = variantNode.id;
  const thisVariantQty = variantNode.inventoryQuantity ?? 0;

  if (isMaster) {
    // Return "master" info
    return {
      isMaster: true,
      variantId: thisVariantId,
      inventoryItemId,
      currentVariantQuantity: thisVariantQty,
    };
  }

  // If not master, check if there's another variant in the same product that
  // is master and has thisVariantId in its childrenkey array.
  const allEdges = variantNode.product?.variants?.edges || [];
  for (const edge of allEdges) {
    const maybeMaster = edge.node;
    const maybeMasterIsTrue = maybeMaster?.metafield?.value === "true";
    if (!maybeMasterIsTrue) continue;

    // Parse children
    let childArr = [];
    try {
      const raw = maybeMaster?.metafield(namespace="projektstocksyncchildren", key="childrenkey")?.value;
      if (raw) {
        childArr = JSON.parse(raw);
      }
    } catch (err) {
      // ignore parse errors
    }

    if (childArr.includes(thisVariantId)) {
      const masterInventoryItemId = maybeMaster?.inventoryItem?.id?.split("/").pop();
      return {
        isChild: true,
        masterVariantId: maybeMaster.id,
        masterInventoryItemId,
        childVariantId: thisVariantId,
        childCurrentQuantity: thisVariantQty,
      };
    }
  }

  return null;
}

/**
 * For a MASTER variant, retrieve all its children by reading the childrenkey array.
 * Then convert each child variant ID => we can find inventoryItemId and current inventory quantity.
 */
async function getChildVariantsData(adminHeaders, masterVariantId) {
  const query = `
    query getMasterVariant($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryQuantity
        metafield(namespace: "projektstocksyncchildren", key: "childrenkey") {
          value
        }
        product {
          variants(first: 50) {
            edges {
              node {
                id
                inventoryQuantity
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
  const variantNode = data?.data?.productVariant;
  if (!variantNode) return [];

  let childVariantIds = [];
  const childrenMfValue = variantNode?.metafield?.value;
  if (childrenMfValue) {
    try {
      childVariantIds = JSON.parse(childrenMfValue); // array of variant GIDs
    } catch (err) {
      console.error("Error parsing childrenkey JSON:", err);
    }
  }

  const allEdges = variantNode.product?.variants?.edges || [];

  // Return an array of object { variantId, currentQuantity, inventoryItemId }
  const childData = [];
  for (const cId of childVariantIds) {
    const foundChild = allEdges.find((edge) => edge.node.id === cId);
    if (foundChild?.node?.inventoryItem?.id) {
      childData.push({
        variantId: cId,
        currentQuantity: foundChild.node.inventoryQuantity ?? 0,
        inventoryItemId: foundChild.node.inventoryItem.id.split("/").pop(),
      });
    }
  }

  return childData;
}

/**
 * The main webhook action with delta-based updates.
 */
export const action = async ({ request }) => {
  console.log("Received webhook request for inventory update.");

  // 1) Verify HMAC
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

  console.log("Webhook signature verified. Proceeding.");

  // 2) Parse the payload
  const payload = JSON.parse(rawBody);
  console.log("Parsed webhook payload:", payload);

  // 3) Authenticate the admin client
  let admin;
  try {
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!token) {
      throw new Error("No SHOPIFY_ACCESS_TOKEN provided.");
    }
    admin = {
      headers: {
        "X-Shopify-Access-Token": token,
      },
    };
  } catch (err) {
    console.error("Authentication error:", err);
    return new Response("Forbidden", { status: 403 });
  }

  // 4) Extract fields from webhook
  const inventoryItemId = payload.inventory_item_id; // numeric
  const newQuantity = payload.available; // numeric
  const locationId = payload.location_id; // numeric

  console.log("Formatted Inventory Item:", `gid://shopify/InventoryItem/${inventoryItemId}`);
  console.log("Location ID:", `gid://shopify/Location/${locationId}`);

  // 5) Check if the item is active in that location. If not, activate it.
  const checkQuery = `
    query CheckInventoryItem($id: ID!) {
      inventoryItem(id: $id) {
        id
        inventoryLevels(first: 10) {
          edges {
            node {
              location {
                id
              }
            }
          }
        }
      }
    }
  `;

  try {
    const checkResp = await fetch(
      "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...admin.headers,
        },
        body: JSON.stringify({
          query: checkQuery,
          variables: {
            id: `gid://shopify/InventoryItem/${inventoryItemId}`,
          },
        }),
      }
    );
    const checkJson = await checkResp.json();
    const itemData = checkJson?.data?.inventoryItem;

    if (!itemData) {
      console.log("Item not found, trying to activate anyway...");
      await activateInventoryItem(admin.headers, inventoryItemId, locationId);
    } else {
      const edges = itemData.inventoryLevels?.edges || [];
      const foundLoc = edges.find(
        (edge) => edge.node.location.id === `gid://shopify/Location/${locationId}`
      );
      if (!foundLoc) {
        console.log("Not active in this location => activating...");
        await activateInventoryItem(admin.headers, inventoryItemId, locationId);
      } else {
        console.log("Already active in this location.");
      }
    }
  } catch (err) {
    console.error("Error checking/activating inventory location:", err);
    return new Response("Server Error", { status: 500 });
  }

  // 6) Now update the item that triggered the webhook
  //    We'll do a delta-based update, so first we need to see the current quantity.
  try {
    // 6a) Fetch current variant info to compute delta
    const variantDataQuery = `
      query getVariantFromItem($id: ID!) {
        inventoryItem(id: $id) {
          id
          variant {
            id
            inventoryQuantity
          }
        }
      }
    `;
    const variantResp = await fetch(
      "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...admin.headers,
        },
        body: JSON.stringify({
          query: variantDataQuery,
          variables: {
            id: `gid://shopify/InventoryItem/${inventoryItemId}`,
          },
        }),
      }
    );
    const variantJson = await variantResp.json();
    const variantNode = variantJson?.data?.inventoryItem?.variant;

    if (!variantNode) {
      // If no variant, can't do delta logic
      console.log("No variant found for this inventoryItem => skipping delta.");
      return new Response("OK", { status: 200 });
    }

    const currentQty = variantNode.inventoryQuantity ?? 0;
    const delta = newQuantity - currentQty;

    if (delta !== 0) {
      console.log(`Adjusting item ${inventoryItemId} by delta: ${delta}`);
      await adjustVariantInventory({
        admin,
        inventoryItemId: inventoryItemId,
        locationId: locationId,
        delta,
      });
    } else {
      console.log("No difference in quantity => no delta adjustment needed.");
    }
  } catch (err) {
    console.error("Error updating the primary item:", err);
    return json({ error: err.message }, { status: 400 });
  }

  // 7) Master-Child logic
  //    Check if this item is a child or a master.
  try {
    const masterChildInfo = await getMasterChildInfo(admin.headers, inventoryItemId);
    if (!masterChildInfo) {
      console.log("No master/child info => done.");
      return new Response("OK", { status: 200 });
    }

    // If it's a child, we update the master, then siblings
    if (masterChildInfo.isChild) {
      console.log(`Item ${inventoryItemId} is CHILD => Master is ${masterChildInfo.masterInventoryItemId}`);
      // 7a) Update Master
      //    We have the child's new quantity from the payload
      //    so we fetch the master's current qty, compute delta, and adjust
      try {
        // Query master's current quantity
        const masterVariantQuery = `
          query getMasterVariantQty($id: ID!) {
            inventoryItem(id: $id) {
              id
              variant {
                id
                inventoryQuantity
              }
            }
          }
        `;
        const masterResp = await fetch(
          "https://projekt-agency-apps.myshopify.com/admin/api/2024-10/graphql.json",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...admin.headers,
            },
            body: JSON.stringify({
              query: masterVariantQuery,
              variables: {
                id: `gid://shopify/InventoryItem/${masterChildInfo.masterInventoryItemId}`,
              },
            }),
          }
        );
        const masterJson = await masterResp.json();
        const masterVariantNode = masterJson?.data?.inventoryItem?.variant;

        if (masterVariantNode) {
          const masterCurrentQty = masterVariantNode.inventoryQuantity ?? 0;
          const masterDelta = newQuantity - masterCurrentQty;
          if (masterDelta !== 0) {
            console.log(`Adjusting master by delta: ${masterDelta}`);
            await adjustVariantInventory({
              admin,
              inventoryItemId: masterChildInfo.masterInventoryItemId,
              locationId,
              delta: masterDelta,
            });
          }
        }
      } catch (err) {
        console.error("Error adjusting master inventory:", err);
      }

      // 7b) Now update siblings
      console.log("Fetching siblings for the master...");
      const siblingVariants = await getChildVariantsData(admin.headers, masterChildInfo.masterVariantId);
      // siblingVariants is an array of objects like:
      // { variantId, currentQuantity, inventoryItemId }
      for (const sibling of siblingVariants) {
        // Skip the child that triggered this webhook
        if (Number(sibling.inventoryItemId) === Number(inventoryItemId)) {
          console.log("Skipping the same child =>", sibling.inventoryItemId);
          continue;
        }
        const siblingDelta = newQuantity - (sibling.currentQuantity ?? 0);
        if (siblingDelta !== 0) {
          console.log(`Adjusting sibling ${sibling.inventoryItemId} by delta ${siblingDelta}`);
          await adjustVariantInventory({
            admin,
            inventoryItemId: sibling.inventoryItemId,
            locationId,
            delta: siblingDelta,
          });
        }
      }

      return new Response("OK", { status: 200 });
    }

    // If it's a master, update each child to match newQuantity
    if (masterChildInfo.isMaster) {
      console.log(`Item ${inventoryItemId} is MASTER => Updating all children...`);
      // 7c) We fetch child's current quantity, compute delta, and adjust
      const childData = await getChildVariantsData(admin.headers, masterChildInfo.variantId);

      // Also get the master's current quantity from the webhook payload's newQuantity
      // or from the variant info we pulled above
      const masterNewQty = newQuantity; // from the payload
      for (const child of childData) {
        const deltaChild = masterNewQty - (child.currentQuantity ?? 0);
        if (deltaChild !== 0) {
          console.log(`Adjusting child ${child.inventoryItemId} by delta ${deltaChild}`);
          await adjustVariantInventory({
            admin,
            inventoryItemId: child.inventoryItemId,
            locationId,
            delta: deltaChild,
          });
        }
      }

      return new Response("OK", { status: 200 });
    }

    // default
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Error in master-child sync logic:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
