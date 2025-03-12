// app/routes/app.sync.jsx
import React, { useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Card, TextField, Button, Modal, Banner, Spinner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

/**
 * Loader for syncing a single variant in real time.
 *
 * Expects a query parameter "variantId".
 * The query fetches the variant details (title, inventory, image, masterMetafield, childrenMetafield)
 * and some product context (like the product title and image) so you know which product this variant belongs to.
 */
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId");
  if (!variantId) {
    throw new Response("Missing variantId", { status: 400 });
  }
  const { session, admin } = await authenticate.admin(request);
  // Synchronous GraphQL query for a single variant:
  const query = `
    query GetVariant($id: ID!) {
      node(id: $id) {
        ... on ProductVariant {
          id
          title
          inventoryQuantity
          image {
            originalSrc
          }
          masterMetafield: metafield(
            namespace: "projektstocksyncmaster"
            key: "master"
          ) {
            id
            value
          }
          childrenMetafield: metafield(
            namespace: "projektstocksyncchildren"
            key: "childrenkey"
          ) {
            id
            value
          }
          ratioMetafield: metafield(
            namespace: "projektstocksyncqtymanagement"
            key: "qtymanagement"
          ) {
            id
            value
          }  
          product {
            id
            title
            images(first: 1) {
              edges {
                node {
                  originalSrc
                }
              }
            }
          }
        }
      }
    }
  `;
  const response = await admin.graphql(query, { variables: { id: variantId } });
  const result = await response.json();
  if (result.errors) {
    console.error("Error fetching variant:", result.errors);
    throw new Response("Error fetching danilo variant data", { status: 500 });
  }
  const variant = result.data.node;
  return json({ variant });
};

export default function SyncVariant() {
  const { variant } = useLoaderData();
  const fetcher = useFetcher();
  
  // Local state for the variant fields.
  const [title, setTitle] = useState(variant.title || "");
  const [inventory, setInventory] = useState(String(variant.inventoryQuantity || 0));
  const [master, setMaster] = useState(variant.masterMetafield?.value === "true");
  const [children, setChildren] = useState(() => {
    try {
      return variant.childrenMetafield?.value ? JSON.parse(variant.childrenMetafield.value) : [];
    } catch (e) {
      console.error("Error parsing children field", e);
      return [];
    }
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);

  // Handler to update the variant synchronously.
  async function handleSave() {
    setIsSaving(true);
    setError(null);
    try {
      // Call your synchronous update API.
      // This endpoint should update the variant in Shopify using your Admin API,
      // and then return the updated variant data.
      const res = await fetch("/api/sync-variant-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId: variant.id,
          title,
          inventory: Number(inventory),
          master,
          children, // Expecting an array of child variant IDs
        }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to update variant");
      }
      // Optionally, refetch updated data (or use the returned data)
      fetcher.load(`/app/sync?variantId=${encodeURIComponent(variant.id)}`);
    } catch (err) {
      console.error("Error updating variant:", err);
      setError(err.message);
    }
    setIsSaving(false);
  }

  return (
    <Page title="Sync Variant">
      <Card sectioned>
        <h2>Sync Variant Details</h2>
        <p>
          <strong>Product:</strong> {variant.product.title}
        </p>
        <img
          src={variant.image?.originalSrc || variant.product.images?.edges?.[0]?.node?.originalSrc}
          alt={variant.title}
          style={{ maxWidth: "200px", marginBottom: "1rem" }}
        />
        <TextField label="Variant Title" value={title} onChange={setTitle} autoComplete="off" />
        <TextField label="Inventory" type="number" value={inventory} onChange={setInventory} autoComplete="off" />
        {/* Here you can use a Toggle or TextField for the master flag */}
        <TextField
          label="Master (true/false)"
          value={master ? "true" : "false"}
          onChange={(val) => setMaster(val.toLowerCase() === "true")}
          autoComplete="off"
        />
        {/* Children field: a JSON array of child variant IDs */}
        <TextField
          label="Children (JSON array)"
          value={JSON.stringify(children)}
          onChange={(val) => {
            try {
              setChildren(JSON.parse(val));
            } catch (e) {
              // If parsing fails, keep previous state or show an error
              console.error("Invalid JSON for children", e);
            }
          }}
          multiline={4}
          autoComplete="off"
        />
        {error && <Banner status="critical">{error}</Banner>}
        {isSaving ? <Spinner accessibilityLabel="Saving" /> : <Button primary onClick={handleSave}>Save Changes</Button>}
      </Card>
    </Page>
  );
}
