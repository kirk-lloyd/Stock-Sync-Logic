import React, { useState, useCallback, useEffect } from "react";
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
  Spinner,
  ResourceList,
  ResourceItem,
  Frame,
  Toast,
} from "@shopify/polaris";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Helper function that extracts the numeric part of a Shopify GID.
 * Example: "gid://shopify/ProductVariant/12345" => "12345"
 */
function parseVariantId(gid = "") {
  return gid.split("/").pop();
}

/**
 * LOADER FUNCTION (Remix)
 *
 * Fetches all products, variants, and relevant metafields.
 * Then it populates child variant data by performing a second query.
 * Finally, returns a structured JSON object to the client.
 */
export const loader = async ({ request }) => {
  console.log(
    "Loader start: Attempting to authenticate, then fetch all products (variant-level metafields)."
  );
  const { admin } = await authenticate.admin(request);

  try {
    console.log(
      "Loader: Auth successful. Performing GraphQL query for products and variant-level metafields..."
    );

    // 1. Fetch products + variants
    const response = await admin.graphql(
      `#graphql\n      query GetAllProducts {\n        products(first: 100) {\n          edges {\n            node {\n              id\n              title\n              createdAt\n              images(first: 1) {\n                edges {\n                  node {\n                    originalSrc\n                  }\n                }\n              }\n              metafields(first: 30) {\n                edges {\n                  node {\n                    namespace\n                    key\n                    value\n                  }\n                }\n              }\n              variants(first: 50) {\n                edges {\n                  node {\n                    id\n                    title\n                    inventoryQuantity\n                    image {\n                      id\n                      originalSrc\n                    }\n                    masterMetafield: metafield(\n                      namespace: \"projektstocksyncmaster\"\n                      key: \"master\"\n                    ) {\n                      id\n                      value\n                    }\n                    childrenMetafield: metafield(\n                      namespace: \"projektstocksyncchildren\"\n                      key: \"childrenkey\"\n                    ) {\n                      id\n                      value\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }`
    );

    const data = await response.json();
    const rawProducts =
      data?.data?.products?.edges?.map((edge) => edge.node) || [];

    // 2. Identify masters & gather child variant IDs
    let allChildVariantIds = [];

    const productsParsed = rawProducts.map((product) => {
      const updatedVariants = product.variants.edges.map((vEdge) => {
        const variant = vEdge.node;
        const isMaster = variant.masterMetafield?.value === "true";

        let childVariantIds = [];
        if (isMaster && variant.childrenMetafield?.value) {
          try {
            const parsedArr = JSON.parse(variant.childrenMetafield.value);
            if (Array.isArray(parsedArr)) {
              childVariantIds = parsedArr;
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

    // 3. Remove duplicates, fetch child variants in a second query
    const uniqueChildIds = [...new Set(allChildVariantIds)];
    let childVariantMap = {};

    if (uniqueChildIds.length > 0) {
      const childResponse = await admin.graphql(
        `#graphql\n        query GetChildVariants($ids: [ID!]!) {\n          nodes(ids: $ids) {\n            ... on ProductVariant {\n              id\n              inventoryQuantity\n              title\n              image {\n                id\n                originalSrc\n              }\n              product {\n                id\n                title\n                images(first: 1) {\n                  edges {\n                    node {\n                      originalSrc\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }`,
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

    // 4. Attach child variant data to each master
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

    return json({ products: finalProducts });
  } catch (error) {
    console.error("Loader error:", error);
    return json({ products: [], error: error.message }, { status: 500 });
  }
};

/**
 * MAIN COMPONENT - ProductsTable
 *
 * Renders a table of Products -> Variants -> Child Variants.
 * Provides controls for:
 * - Marking a variant as Master.
 * - Managing children (linking them to a master variant).
 * - Editing inventory.
 *
 * IMPORTANT ADDITION:
 * We enforce these rules:
 * 1) If a variant is a child of any master, it CANNOT become a master.
 * 2) If a variant is a master, it CANNOT become a child.
 * 3) A variant can only be a child of one master at a time.
 * 4) If a user tries to make an invalid configuration, display a notification.
 */
export default function ProductsTable() {
  const { products: initialProducts } = useLoaderData();
  const revalidator = useRevalidator();

  // Local state for all products
  const [products, setProducts] = useState(initialProducts);

  // Keep products in sync with loader whenever it changes
  useEffect(() => {
    setProducts(initialProducts);
  }, [initialProducts]);

  const [expandedProductIndex, setExpandedProductIndex] = useState(-1);

  // Inventory modal
  const [modalActive, setModalActive] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);

  // Children management modal
  const [childrenModalActive, setChildrenModalActive] = useState(false);

  // For editing inventory in a modal
  const [inventory, setInventory] = useState({});

  // Keep a flattened list of all variants for selection as children
  const [allVariants, setAllVariants] = useState([]);
  const [childrenSelection, setChildrenSelection] = useState([]);

  // Toast (for error notifications)
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  /**
   * showToast:
   * Helper function to display an error or info message using a Polaris Toast.
   */
  function showToast(message) {
    setToastMessage(message);
    setToastActive(true);
  }

  /**
   * onDismissToast:
   * Dismiss the Toast.
   */
  function onDismissToast() {
    setToastActive(false);
    setToastMessage("");
  }

  // Helper: Check if a variant is child of a different master.
  function findMasterOfVariant(variantId) {
    // We'll search across all products and their variants.
    for (const prod of products) {
      for (const ve of prod.variants.edges) {
        const possibleMaster = ve.node;
        if (
          possibleMaster.isMaster &&
          possibleMaster.childVariantIds?.includes(variantId)
        ) {
          // Return the variant + product info
          return {
            masterVariant: possibleMaster,
            masterProductTitle: prod.title,
          };
        }
      }
    }
    return null;
  }

  // Setup a useEffect to flatten all variants for the child selection list
  useEffect(() => {
    const variantsList = [];
    products.forEach((prod) => {
      prod.variants.edges.forEach((ve) => {
        variantsList.push({
          ...ve.node,
          productTitle: prod.title,
          productImage: prod.images?.edges?.[0]?.node?.originalSrc || "",
        });
      });
    });
    setAllVariants(variantsList);
  }, [products]);

  // Expand or collapse product row
  const toggleExpanded = useCallback(
    (index) => () => {
      setExpandedProductIndex((prev) => (prev === index ? -1 : index));
    },
    []
  );

  // INVENTORY MODAL
  function toggleModal() {
    setModalActive((prev) => !prev);
  }

  function openInventoryModal(product) {
    setSelectedProduct(product);
    const invObj = {};
    product.variants.edges.forEach((ve) => {
      invObj[ve.node.id] = ve.node.inventoryQuantity;
    });
    setInventory(invObj);
    toggleModal();
  }

  // CHILDREN MODAL
  function toggleChildrenModal() {
    setChildrenModalActive((prev) => !prev);
  }

  function openChildrenModal(product, variant) {
    // If this variant is not a master, do not allow opening children config
    // because rule #2 says a variant that is not master cannot have children.
    if (!variant.isMaster) {
      showToast(
        "Cannot manage children: this variant is not marked as Master."
      );
      return;
    }

    setSelectedProduct(product);
    setSelectedVariant(variant);

    // Pre-populate the selection with the existing children
    const existingChildren = variant.childVariantIds || [];
    setChildrenSelection(existingChildren);

    toggleChildrenModal();
  }

  /**
   * When toggling a child selection in the modal, we simply add/remove from local state.
   * Final checks happen when user saves.
   */
  function handleToggleChildSelection(variantGid) {
    setChildrenSelection((prev) => {
      if (prev.includes(variantGid)) {
        return prev.filter((id) => id !== variantGid);
      } else {
        return [...prev, variantGid];
      }
    });
  }

  /**
   * handleSaveChildren:
   * Called when the user clicks "Save Children" in the children modal.
   * We'll confirm that none of these children are themselves masters or already children of a different master.
   * If any invalid config is found, we show a toast and do not save.
   */
  function handleSaveChildren() {
    if (!selectedVariant) return;

    // We'll do some validation checks.
    // 1) Gather invalid children.
    const invalidChildren = [];

    childrenSelection.forEach((childId) => {
      // Find the variant's full data from allVariants
      const childData = allVariants.find((v) => v.id === childId);
      if (!childData) return; // skip if not found

      // a) If child is Master, it's invalid.
      if (childData.isMaster) {
        invalidChildren.push({
          childId,
          reason: `Variant ${parseVariantId(childId)} is Master, cannot be a child.`,
        });
        return;
      }

      // b) If child is already a child of a different master
      const foundMaster = findMasterOfVariant(childId);
      if (
        foundMaster &&
        // We only block if the master is not the same as the one we're editing
        foundMaster.masterVariant.id !== selectedVariant.id
      ) {
        invalidChildren.push({
          childId,
          reason: `Variant ${parseVariantId(childId)} is already a child of master variant in '${foundMaster.masterProductTitle}'`,
        });
      }
    });

    if (invalidChildren.length > 0) {
      // We'll just show the first error reason for simplicity,
      // or we can show them all if we prefer.
      showToast(
        `Cannot save children. ${invalidChildren[0].reason}`
      );
      return;
    }

    // If we pass validation, save to server.
    handleAddChildren(selectedVariant.id, childrenSelection);
    toggleChildrenModal();
  }

  // Update or remove a variant's master metafield
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
      throw error;
    }
  }

  /**
   * handleMasterCheckboxChange:
   * When the user toggles the checkbox to mark a variant as Master or not.
   * We enforce rule #1: if the variant is a child of any master, it cannot become master.
   * Also, if the variant is master, it cannot be in someone else's children.
   */
  async function handleMasterCheckboxChange(productId, variantId, newChecked) {
    // We'll do some checks before we finalize.

    // 1) If the user is trying to set it to Master (newChecked = true)
    //    verify that this variant is NOT already a child of another master.
    if (newChecked) {
      const foundMaster = findMasterOfVariant(variantId);
      if (foundMaster) {
        // This means we found a different master that includes this variant.
        showToast(
          `Cannot set as master. This variant is already a child of a master in '${foundMaster.masterProductTitle}'.`
        );
        return; // do not proceed
      }
    } else {
      // If the user is UNchecking, i.e. removing Master status,
      // we do not strictly block it, even if it has children. But we could.
      // For now, let's allow it.
    }

    // 2) Optimistic UI update
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

    // 3) Update on server
    try {
      await updateMasterMetafield(variantId, newChecked);
      // Optionally revalidate
      // revalidator.revalidate();
    } catch (error) {
      // If server fails, revert
      console.error("Failed to update master metafield on server:", error);
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
   * handleAddChildren:
   * Actually saves the children IDs to the server for the given Master variant.
   * Then triggers a revalidation to refresh data.
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

      // Optimistic update
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

      // Force a data refresh
      revalidator.revalidate();
    } catch (error) {
      console.error("Error updating childrenkey:", error);
    }
  }

  /**
   * handleInventoryChange:
   * Update local state with the user-specified quantity.
   */
  function handleInventoryChange(variantId, newQuantity) {
    setInventory((prev) => ({ ...prev, [variantId]: newQuantity }));
  }

  /**
   * updateInventory:
   * Saves all the updated quantities to the server for each variant of the selected product.
   * Then revalidates to refresh the data.
   */
  async function updateInventory() {
    if (!selectedProduct) return;

    try {
      // Send an API call for each variant
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

      // Optimistic update
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

      // Refresh from server
      revalidator.revalidate();
    } catch (error) {
      console.error("Error in updateInventory:", error);
    }
  }

  // RENDER
  return (
    <Frame>
      <Page title="All Products">
        <Layout>
          <Layout.Section>
            <Card>
              <IndexTable
                itemCount={products.length}
                selectable={false}
                headings={[
                  { title: "Product / Variant" },
                  { title: "Date Created" },
                  { title: "Active Masters" },
                  { title: "Actions" },
                ]}
              >
                {products.map((product, productIndex) => {
                  const isExpanded = expandedProductIndex === productIndex;

                  // Count how many variants are Master
                  const masterCount = product.variants.edges.filter(
                    (edge) => edge.node.isMaster
                  ).length;

                  // MAIN PRODUCT ROW
                  const productRowMarkup = (
                    <IndexTable.Row
                      id={product.id}
                      key={product.id}
                      position={productIndex}
                      onClick={toggleExpanded(productIndex)}
                    >
                      <IndexTable.Cell>
                        <Thumbnail
                          source={
                            product.images.edges[0]?.node.originalSrc || ""
                          }
                          alt={product.title}
                        />
                        &nbsp; {product.title} ( {" "}
                        {product.variants.edges.length} variants )
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        {new Date(product.createdAt).toLocaleDateString()}
                      </IndexTable.Cell>

                      <IndexTable.Cell>{masterCount}</IndexTable.Cell>

                      <IndexTable.Cell>
                        <Button
                          onClick={(e) => {
                            e.stopPropagation();
                            openInventoryModal(product);
                          }}
                        >
                          Edit Inventory
                        </Button>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );

                  // If expanded, show each variant and possible child variants
                  let variantSubRows = null;
                  if (isExpanded) {
                    variantSubRows = product.variants.edges.map(
                      (variantEdge, variantIndex) => {
                        const variant = variantEdge.node;
                        const { isMaster, childVariants } = variant;

                        // fallback to product image if no variant image
                        const variantImage =
                          variant.image?.originalSrc ||
                          product.images.edges[0]?.node.originalSrc ||
                          "";

                        const shortVariantId = parseVariantId(variant.id);

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
                                  <p>
                                    Inventory: {variant.inventoryQuantity ?? 0}
                                  </p>
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
                                  primary
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openChildrenModal(product, variant);
                                  }}
                                  style={{ marginLeft: "0.5rem" }}
                                >
                                  Manage Children
                                </Button>
                              )}
                            </IndexTable.Cell>
                          </IndexTable.Row>
                        );

                        // CHILD ROWS
                        let childVariantRows = [];
                        if (isMaster && childVariants?.length > 0) {
                          childVariantRows = childVariants.map(
                            (childVar, childIndex) => {
                              const childImage =
                                childVar.image?.originalSrc ||
                                childVar.product?.images?.edges?.[0]?.node
                                  .originalSrc ||
                                "";
                              const childTitle =
                                childVar.product?.title || "Untitled";
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
                                        <Tag>
                                          Child Variant: {shortChildId}
                                        </Tag>
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

        {/* INVENTORY MODAL */}
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
                  Adjust the inventory for all variants of {" "}
                  {selectedProduct.title} below:
                </p>
              </TextContainer>

              {selectedProduct.variants.edges.map((ve) => {
                const variantObj = ve.node;
                const shortVariantId = parseVariantId(variantObj.id);
                return (
                  <div key={variantObj.id} style={{ marginBottom: "1rem" }}>
                    <Tag>Variant: {variantObj.title}</Tag>
                    <p>ID: {shortVariantId}</p>
                    <TextField
                      label="Inventory Quantity"
                      type="number"
                      value={String(inventory[variantObj.id] ?? "")}
                      onChange={(value) =>
                        handleInventoryChange(variantObj.id, value)
                      }
                    />
                  </div>
                );
              })}
            </Modal.Section>
          </Modal>
        )}

        {/* CHILDREN MANAGEMENT MODAL */}
        {childrenModalActive && selectedVariant && (
          <Modal
            open={childrenModalActive}
            onClose={toggleChildrenModal}
            title={`Manage Children for Master Variant ${parseVariantId(
              selectedVariant.id
            )}`}
            primaryAction={{
              content: "Save Children",
              onAction: handleSaveChildren,
            }}
            secondaryActions={[
              {
                content: "Cancel",
                onAction: toggleChildrenModal,
              },
            ]}
          >
            <Modal.Section>
              <TextContainer>
                <p>
                  Below you can select which variants should become children of
                  this master variant. Current selections are pre-checked.
                </p>
              </TextContainer>
              {allVariants.length === 0 && <Spinner accessibilityLabel="Loading" />}
              {allVariants.length > 0 && (
                <ResourceList
                  resourceName={{ singular: "variant", plural: "variants" }}
                  items={allVariants.filter((v) => v.id !== selectedVariant.id)}
                  renderItem={(item) => {
                    const shortId = parseVariantId(item.id);
                    const media = (
                      <Thumbnail
                        source={
                          item.image?.originalSrc || item.productImage || ""
                        }
                        size="small"
                        alt={item.title}
                      />
                    );
                    const isChecked = childrenSelection.includes(item.id);

                    return (
                      <ResourceItem
                        id={item.id}
                        media={media}
                        accessibilityLabel={`Select ${item.title}`}
                      >
                        <div
                          style={{ display: "flex", alignItems: "center" }}
                        >
                          <Checkbox
                            checked={isChecked}
                            onChange={() => handleToggleChildSelection(item.id)}
                          />
                          <div style={{ marginLeft: "1rem" }}>
                            <Tag>
                              {item.productTitle} - Variant: {item.title}
                            </Tag>
                            <p>ID: {shortId}</p>
                          </div>
                        </div>
                      </ResourceItem>
                    );
                  }}
                />
              )}
            </Modal.Section>
          </Modal>
        )}
      </Page>

      {/* TOAST FOR ERROR NOTIFICATIONS */}
      {toastActive && (
        <Toast content={toastMessage} onDismiss={onDismissToast} error />
      )}
    </Frame>
  );
}
