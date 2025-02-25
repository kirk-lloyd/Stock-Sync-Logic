// app/routes/api/update-oldqty.jsx
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust path if needed
import prisma from "../db.server.js"; // Adjust path if needed

/**
 * This route accepts a POST request with JSON such as:
 *   { "variantId": "gid://shopify/ProductVariant/12345", "newQty": 22 }
 *
 * Upon receiving this, it:
 *  1) Authenticates the shop from the session (so we can determine
 *     the relevant shop domain and access token).
 *  2) Stores the newQty into our Prisma database as 'oldQuantity'
 *     (just as your webhook logic does).
 *  3) Updates the 'qtyold' metafield in Shopify for reference,
 *     using the 'projektstocksyncqtyold' namespace.
 * ------------------------------------------------------------------
 */

/**
 * normaliseVariantId:
 * Strips the "gid://shopify/ProductVariant/" prefix if present,
 * leaving you with just the numeric part (e.g. "12345").
 */
function normaliseVariantId(gid) {
  if (!gid) return null;
  return gid.replace("gid://shopify/ProductVariant/", "");
}

/**
 * setQtyOldValueShopify:
 * Writes the newQty to the 'qtyold' metafield in Shopify.
 */
async function setQtyOldValueShopify(adminApiHeaders, shopDomain, variantId, newQty) {
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

  const response = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      ...adminApiHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const data = await response.json();
  if (data.errors) {
    console.error("setQtyOldValueShopify => GraphQL errors:", data.errors);
    throw new Error("Failed to update qtyold metafield on Shopify.");
  } else if (data.data?.metafieldsSet?.userErrors?.length) {
    console.error("setQtyOldValueShopify => userErrors:", data.data.metafieldsSet.userErrors);
    throw new Error("User errors when updating qtyold metafield on Shopify.");
  }

  console.log(`✅ Successfully updated 'qtyold' to ${newQty} for variant: ${variantId}`);
}

/**
 * setQtyOldValueDB:
 * Writes the newQty to your Prisma database as 'oldQuantity'.
 * Adjust field names and model references to suit your schema.
 */
async function setQtyOldValueDB(shopDomain, variantId, newQty) {
  const normalisedId = normaliseVariantId(variantId);

  // Example 'Stockdb' table with a composite unique constraint on (shop, productVariantId).
  // If no record exists, this creates one; otherwise it updates the existing row.
  await prisma.stockdb.upsert({
    where: {
      // This name depends on how your schema is set. In many cases,
      // you'll have a compound ID named "shop_productVariantId" or similar.
      shop_productVariantId: {
        shop: shopDomain,
        productVariantId: normalisedId,
      },
    },
    update: {
      oldQuantity: newQty,
    },
    create: {
      shop: shopDomain,
      productVariantId: normalisedId,
      oldQuantity: newQty,
      title: "Unknown",      // You could populate real product title if known
      productId: "unknown",  // or store actual product GID if you have it
      productHandle: "unknown",
    },
  });

  console.log(
    `✅ Updated DB oldQuantity => ${newQty} for shop: ${shopDomain}, variant: ${normalisedId}`
  );
}

/**
 * action:
 * Remix's form/action handler for POST requests to /api/update-oldqty.
 * Accepts a JSON body with { variantId, newQty }, then updates both
 * the DB (oldQuantity) and the Shopify 'qtyold' metafield for reference.
 */
export async function action({ request }) {
  try {
    // 1) Authenticate & parse request body
    const { admin, session } = await authenticate.admin(request);
    const { variantId, newQty } = await request.json();
    if (!variantId || typeof newQty === "undefined") {
      return json({ success: false, error: "Missing variantId or newQty." }, { status: 400 });
    }

    const shopDomain = session?.shop; 
    if (!shopDomain) {
      return json({ success: false, error: "No shop found in session." }, { status: 403 });
    }

    // 2) Update DB => set oldQuantity
    await setQtyOldValueDB(shopDomain, variantId, newQty);

    // 3) Update Shopify => set qtyold metafield
    const adminHeaders = {
      "X-Shopify-Access-Token": session.accessToken,
    };
    await setQtyOldValueShopify(adminHeaders, shopDomain, variantId, newQty);

    // 4) Return success
    return json({ success: true, message: "OldQty updated successfully." }, { status: 200 });
  } catch (error) {
    console.error("❌ /api/update-oldqty => error:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
}
