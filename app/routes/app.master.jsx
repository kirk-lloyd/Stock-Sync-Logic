import React, { useState, useCallback } from "react";
import {
  Card,
  Layout,
  Page,
  IndexTable,
  Thumbnail,
  Checkbox,
  Button,
  Modal,
  TextField,
  TextContainer,
  Tag,
} from "@shopify/polaris";
import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node"; // or "@remix-run/server-runtime"
import { authenticate } from "../shopify.server"; // Adjust path as needed

/**
 * Utility function: Given a Shopify GID like "gid://shopify/ProductVariant/123456",
 * returns only the last numeric portion "123456".
 */
function parseVariantId(gid = "") {
  return gid.split("/").pop();
}

/**
 * LOADER FUNCTION (Remix)
 *
 * 1. Fetches all products and variant metafields.
 * 2. Identifies master variants and gathers child variant IDs.
 * 3. Performs a second query to fetch details of child variants.
 * 4. Attaches child variant data to their respective master variants.
 * 5. Filters out products that do NOT have any master variants.
 */
export const loader = async ({ request }) => {
  console.log(
    "Loader (app.master.jsx): Fetching products, but only displaying those with a master variant."
  );

  const { admin } = await authenticate.admin(request);

  try {
    // 1) GraphQL Query: Fetch products, their variants, and relevant metafields
    const response = await admin.graphql(
      `#graphql
      query GetAllProducts {
        products(first: 100) {
          edges {
            node {
              id
              title
              createdAt
              images(first: 1) {
                edges {
                  node {
                    originalSrc
                  }
                }
              }
              metafields(first: 30) {
                edges {
                  node {
                    namespace
                    key
                    value
                  }
                }
              }
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    inventoryQuantity
                    image {
                      id
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
                  }
                }
              }
            }
          }
        }
      }`
    );

    const data = await response.json();
    const rawProducts = data?.data?.products?.edges?.map((edge) => edge.node) || [];
    console.log("Loader: Fetched", rawProducts.length, "products in total.");

    // 2) Determine which variants are master and gather child IDs
    let allChildVariantIds = [];

    const productsParsed = rawProducts.map((product) => {
      const updatedVariants = product.variants.edges.map((vEdge) => {
        const variant = vEdge.node;
        const isMaster = variant.masterMetafield?.value === "true";

        let childVariantIds = [];
        if (isMaster && variant.childrenMetafield?.value) {
          try {
            const parsed = JSON.parse(variant.childrenMetafield.value);
            if (Array.isArray(parsed)) {
              childVariantIds = parsed;
            }
          } catch (error) {
            console.error("Error parsing children for variant", variant.id, error);
          }
        }
        allChildVariantIds.push(...childVariantIds);

        return {
          ...variant,
          isMaster,
          childVariantIds,
        };
      });

      return {
        ...product,
        variants: {
          edges: updatedVariants.map((v) => ({ node: v })),
        },
      };
    });

    // 3) Second query for any child variants
    const uniqueChildIds = [...new Set(allChildVariantIds)];
    let childVariantMap = {};

    if (uniqueChildIds.length > 0) {
      console.log("Loader: Fetching child variants...");
      const childResponse = await admin.graphql(
        `#graphql
        query GetChildVariants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              inventoryQuantity
              title
              image {
                id
                originalSrc
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
        }`,
        { variables: { ids: uniqueChildIds } }
      );

      const childData = await childResponse.json();
      const childNodes = childData?.data?.nodes || [];
      childNodes.forEach((childVariant) => {
        if (childVariant?.id) {
          childVariantMap[childVariant.id] = childVariant;
        }
      });
    }

    // Attach the child variants to their master
    const finalProducts = productsParsed.map((product) => {
      const newEdges = product.variants.edges.map((edge) => {
        const variant = edge.node;
        const resolvedChildren = variant.childVariantIds
          .map((id) => childVariantMap[id])
          .filter(Boolean);

        return {
          node: {
            ...variant,
            childVariants: resolvedChildren,
          },
        };
      });

      return {
        ...product,
        variants: {
          edges: newEdges,
        },
      };
    });

    // 4) Filter out products that have no master variant
    const filteredProducts = finalProducts.filter((prod) =>
      prod.variants.edges.some((edge) => edge.node.isMaster === true)
    );

    console.log(
      "Loader: Original count:",
      finalProducts.length,
      " => Filtered (with master):",
      filteredProducts.length
    );

    return json({ products: filteredProducts });
  } catch (error) {
    console.error("Loader error:", error);
    return json({ products: [], error: error.message }, { status: 500 });
  }
};

/**
 * COMPONENT: MasterProductsTable
 *
 * Renders only those products that contain at least one variant with "master" = true.
 * Displays variant IDs as numeric only (e.g., "45745362895068" instead of the full GID).
 * All other functionalities (nested rows, child variants, inventory editing) remain unchanged.
 */
export default function MasterProductsTable() {
  const { products: initialProducts } = useLoaderData();

  // State variables
  const [products, setProducts] = useState(initialProducts);
  const [expandedProductIndex, setExpandedProductIndex] = useState(-1);

  // Modal state variables
  const [modalActive, setModalActive] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);

  // Inventory state (key: variantId -> quantity)
  const [inventory, setInventory] = useState({});

  /**
   * Toggles expanded/collapsed row for a product
   */
  const toggleExpanded = useCallback(
    (index) => () => {
      setExpandedProductIndex((prev) => (prev === index ? -1 : index));
    },
    []
  );

  /**
   * Toggles modal open/close
   */
  function toggleModal() {
    setModalActive(!modalActive);
  }

  /**
   * Opens the inventory modal for a given product, populating local state with its variants' inventory.
   */
  function openInventoryModal(product) {
    setSelectedProduct(product);

    const invObj = {};
    product.variants.edges.forEach((ve) => {
      invObj[ve.node.id] = ve.node.inventoryQuantity;
    });
    setInventory(invObj);

    toggleModal();
  }

  /**
   * Updates the "master" metafield for a variant in Shopify.
   */
  async function updateMasterMetafield(variantId, isMaster) {
    try {
      const response = await fetch("/api/update-variant-metafield", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId,
          namespace: "projektstocksyncmaster",
          key: "master",
          value: isMaster ? "true" : "false",
        }),
      });
      if (!response.ok) {
        throw new Error("Failed to update variant-level 'master' metafield");
      }
    } catch (error) {
      console.error("Error updating 'master' metafield:", error);
    }
  }

  /**
   * Toggle the Master checkbox for a variant.
   * - Uses optimistic UI update
   * - Reverts on server error
   */
  async function handleMasterCheckboxChange(
    productId,
    variantId,
    newChecked
  ) {
    // 1) Optimistic UI update
    setProducts((prev) =>
      prev.map((prod) => {
        if (prod.id !== productId) return prod;
        const updatedEdges = prod.variants.edges.map((edge) => {
          if (edge.node.id === variantId) {
            return {
              ...edge,
              node: {
                ...edge.node,
                isMaster: newChecked,
                masterMetafield: {
                  ...edge.node.masterMetafield,
                  value: newChecked ? "true" : "false",
                },
              },
            };
          }
          return edge;
        });
        return { ...prod, variants: { edges: updatedEdges } };
      })
    );

    // 2) Server update
    try {
      await updateMasterMetafield(variantId, newChecked);
    } catch (error) {
      console.error("Failed to update 'master' metafield on server:", error);

      // Revert the UI update if server update fails
      setProducts((prev) =>
        prev.map((prod) => {
          if (prod.id !== productId) return prod;
          const revertedEdges = prod.variants.edges.map((edge) => {
            if (edge.node.id === variantId) {
              return {
                ...edge,
                node: {
                  ...edge.node,
                  isMaster: !newChecked,
                  masterMetafield: {
                    ...edge.node.masterMetafield,
                    value: !newChecked ? "true" : "false",
                  },
                },
              };
            }
            return edge;
          });
          return { ...prod, variants: { edges: revertedEdges } };
        })
      );
    }
  }

  /**
   * Adds children to a master variant (updates "childrenkey" metafield).
   */
  async function handleAddChildren(variantId, newChildren) {
    if (!variantId) return;
    try {
      const response = await fetch("/api/update-variant-metafield", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId,
          namespace: "projektstocksyncchildren",
          key: "childrenkey",
          value: JSON.stringify(newChildren),
        }),
      });
      if (!response.ok) {
        throw new Error("Failed to update childrenkey");
      }

      // Update local state to reflect new children
      setProducts((prev) =>
        prev.map((prod) => {
          const newEdges = prod.variants.edges.map((edge) => {
            if (edge.node.id === variantId) {
              return {
                ...edge,
                node: {
                  ...edge.node,
                  childrenMetafield: {
                    ...edge.node.childrenMetafield,
                    value: JSON.stringify(newChildren),
                  },
                  childVariantIds: newChildren,
                },
              };
            }
            return edge;
          });
          return { ...prod, variants: { edges: newEdges } };
        })
      );

      toggleModal();
    } catch (error) {
      console.error("Error updating childrenkey:", error);
    }
  }

  /**
   * Handle local inventory input changes
   */
  function handleInventoryChange(variantId, newQuantity) {
    setInventory((prev) => ({ ...prev, [variantId]: newQuantity }));
  }

  /**
   * Saves inventory changes to the backend
   */
  async function updateInventory() {
    if (!selectedProduct) return;

    try {
      const calls = Object.entries(inventory).map(([varId, qty]) =>
        fetch("/api/update-inventory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            variantId: varId,
            newQuantity: Number(qty),
          }),
        })
      );
      await Promise.all(calls);

      // Reflect the changes in local state
      setProducts((prev) =>
        prev.map((prod) => {
          if (prod.id !== selectedProduct.id) return prod;
          const newEdges = prod.variants.edges.map((edge) => {
            if (edge.node.id in inventory) {
              return {
                ...edge,
                node: {
                  ...edge.node,
                  inventoryQuantity: Number(inventory[edge.node.id]),
                },
              };
            }
            return edge;
          });
          return { ...prod, variants: { edges: newEdges } };
        })
      );

      toggleModal();
    } catch (error) {
      console.error("Error in updateInventory:", error);
    }
  }

  /**
   * RENDER
   * The same nested-row IndexTable, but only showing products that have a master variant.
   * Now uses parseVariantId(gid) to display the short ID (numeric only).
   * The "Master?" column displays the count of active master variants instead of "--".
   */
  return (
    <Page title="Master Products">
      <Layout>
        <Layout.Section>
          <Card>
            <IndexTable
              itemCount={products.length}
              selectable={false}
              headings={[
                { title: "Product / Variant" },
                { title: "Date Created" },
                { title: "Master?" }, // Now displays the count of active master variants
                { title: "Actions" },
              ]}
            >
              {products.map((product, productIndex) => {
                const isExpanded = expandedProductIndex === productIndex;

                // 1) Count how many variants are marked as Master
                const masterCount = product.variants.edges.filter(
                  (edge) => edge.node.isMaster
                ).length;

                // MAIN PRODUCT ROW MARKUP
                const productRowMarkup = (
                  <IndexTable.Row
                    id={product.id}
                    key={product.id}
                    position={productIndex}
                    onClick={toggleExpanded(productIndex)}
                  >
                    <IndexTable.Cell>
                      <Thumbnail
                        source={product.images.edges[0]?.node.originalSrc || ""}
                        alt={product.title}
                      />
                      &nbsp; {product.title} ({product.variants.edges.length} variants)
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(product.createdAt).toLocaleDateString()}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {masterCount}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {/* Button to open inventory modal */}
                      <Button
                        onClick={(e) => {
                          e.stopPropagation(); // Prevent the row expansion toggle
                          openInventoryModal(product);
                        }}
                      >
                        Edit Inventory
                      </Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );

                // SUBROWS: Each variant if product is expanded
                let variantSubRows = null;
                if (isExpanded) {
                  variantSubRows = product.variants.edges.map(
                    (variantEdge, variantIndex) => {
                      const variant = variantEdge.node;
                      const { isMaster, childVariants } = variant;

                      const variantImage =
                        variant.image?.originalSrc ||
                        product.images.edges[0]?.node.originalSrc ||
                        "";

                      // Parse the numeric portion of the variant GID
                      const shortVariantId = parseVariantId(variant.id);

                      // VARIANT ROW MARKUP
                      const variantRow = (
                        <IndexTable.Row
                          subrow
                          id={`variant-${variant.id}`}
                          key={variant.id}
                          position={productIndex + 1 + variantIndex}
                        >
                          <IndexTable.Cell>
                            <div
                              style={{
                                marginLeft: "2rem",
                                display: "flex",
                                alignItems: "center",
                              }}
                            >
                              <Thumbnail
                                source={variantImage}
                                size="small"
                                alt={variant.title}
                              />
                              <div style={{ marginLeft: "1rem" }}>
                                <Tag>Variant: {variant.title}</Tag>
                                <p>ID: {shortVariantId}</p>
                                <p>Inventory: {variant.inventoryQuantity ?? 0}</p>
                              </div>
                            </div>
                          </IndexTable.Cell>
                          <IndexTable.Cell />
                          <IndexTable.Cell>
                            {/* Checkbox to toggle Master status */}
                            <Checkbox
                              checked={isMaster}
                              onChange={(checked) =>
                                handleMasterCheckboxChange(
                                  product.id,
                                  variant.id,
                                  checked
                                )
                              }
                            />
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {isMaster && (
                              <Button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedProduct(product);
                                  setSelectedVariant(variant);
                                  toggleModal();
                                }}
                              >
                                +Add Children
                              </Button>
                            )}
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      );

                      // CHILD VARIANT ROWS IF VARIANT IS MASTER
                      let childVariantRows = [];
                      if (isMaster && childVariants?.length > 0) {
                        childVariantRows = childVariants.map(
                          (childVar, childIndex) => {
                            const childImage =
                              childVar.image?.originalSrc ||
                              childVar.product?.images?.edges?.[0]?.node.originalSrc ||
                              "";
                            const childTitle = childVar.product?.title || "Untitled";

                            // Parse the numeric portion for child GIDs
                            const shortChildId = parseVariantId(childVar.id);

                            return (
                              <IndexTable.Row
                                subrow
                                id={`childVar-${childVar.id}`}
                                key={childVar.id}
                                position={
                                  productIndex + 2 + variantIndex + childIndex
                                }
                              >
                                <IndexTable.Cell colSpan={4}>
                                  <div
                                    style={{
                                      marginLeft: "4rem",
                                      display: "flex",
                                      alignItems: "center",
                                    }}
                                  >
                                    <Thumbnail
                                      source={childImage}
                                      alt={childTitle}
                                      size="small"
                                    />
                                    <div style={{ marginLeft: "1rem" }}>
                                      <Tag>Child Variant: {shortChildId}</Tag>
                                      <p>
                                        <strong>Product:</strong> {childTitle}
                                      </p>
                                      <p>
                                        <strong>Inventory:</strong>{" "}
                                        {childVar.inventoryQuantity ?? "??"}
                                      </p>
                                    </div>
                                  </div>
                                </IndexTable.Cell>
                              </IndexTable.Row>
                            );
                          }
                        );
                      }

                      return (
                        <React.Fragment key={variant.id}>
                          {variantRow}
                          {childVariantRows}
                        </React.Fragment>
                      );
                    }
                  );
                }

                return (
                  <React.Fragment key={product.id}>
                    {productRowMarkup}
                    {variantSubRows}
                  </React.Fragment>
                );
              })}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Shared modal for editing inventory and adding children */}
      {modalActive && selectedProduct && (
        <Modal
          open={modalActive}
          onClose={toggleModal}
          title={`Editing Inventory - ${selectedProduct.title}`}
          primaryAction={{
            content: "Save Inventory",
            onAction: updateInventory,
          }}
          secondaryActions={[
            {
              content: "Close",
              onAction: toggleModal,
            },
          ]}
        >
          <Modal.Section>
            <TextContainer>
              <p>
                Adjust the inventory for all variants of {selectedProduct.title} below:
              </p>
            </TextContainer>

            {/* Inventory editing for all variants */}
            {selectedProduct.variants.edges.map((ve) => {
              const variantObj = ve.node;
              // Convert GID to numeric ID in the modal as well
              const shortVariantId = parseVariantId(variantObj.id);

              return (
                <div key={variantObj.id} style={{ marginBottom: "1rem" }}>
                  <Tag>Variant: {variantObj.title}</Tag>
                  <p>ID: {shortVariantId}</p>
                  <TextField
                    label="Inventory Quantity"
                    type="number"
                    value={String(inventory[variantObj.id] ?? "")}
                    onChange={(value) => handleInventoryChange(variantObj.id, value)}
                  />
                </div>
              );
            })}

            {/* If a master variant is selected, show the add-children UI */}
            {selectedVariant && selectedVariant.isMaster && selectedVariant.id && (
              <Card.Section title="Add Children">
                <TextContainer>
                  <p>
                    Add child variant IDs to master variant{" "}
                    {parseVariantId(selectedVariant.id)} here:
                  </p>
                  <Button
                    onClick={() => {
                      // Example children array
                      const exampleChildren = [
                        "gid://shopify/ProductVariant/123",
                        "gid://shopify/ProductVariant/456",
                      ];
                      handleAddChildren(selectedVariant.id, exampleChildren);
                    }}
                  >
                    Add Sample Children
                  </Button>
                </TextContainer>
              </Card.Section>
            )}
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
