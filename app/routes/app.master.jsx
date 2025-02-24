import React, { useState, useCallback, useEffect } from "react";
import {
  Box,
  Card,
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
  Text,
  Pagination,
  Icon,
} from "@shopify/polaris";
import { SearchIcon, XCircleIcon } from "@shopify/polaris-icons";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { TitleBar } from "@shopify/app-bridge-react";

/**
 * parseVariantId:
 * Extracts the numeric portion from a Shopify GID string.
 * For instance, "gid://shopify/ProductVariant/12345" will return "12345".
 */
function parseVariantId(gid = "") {
  return gid.split("/").pop();
}

/**
 * Loader function:
 * Authenticates with Shopify, retrieves all products and their variants, then determines
 * which variants are designated as 'master'. It also fetches additional details
 * for child variants and attaches those details to their relevant master variants.
 *
 * In this modified version, we only return products that actually have at least one
 * master variant. Moreover, each product returned will only contain those variants
 * with 'isMaster' set to true (i.e. `masterMetafield?.value === "true"`).
 */
export const loader = async ({ request }) => {
  console.log("Loader start: Authenticating and retrieving products…");
  const { admin } = await authenticate.admin(request);

  try {
    console.log("Authentication successful. Querying product data…");
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
    const rawProducts =
      data?.data?.products?.edges?.map((edge) => edge.node) || [];

    // Build an augmented list of products, marking variants as master if appropriate
    // and extracting child variant IDs for each master variant.
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

        return { ...variant, isMaster, childVariantIds };
      });
      return {
        ...product,
        variants: { edges: updatedVariants.map((v) => ({ node: v })) },
      };
    });

    // Fetch data for all unique child variant IDs, then map them by ID for easy reference.
    const uniqueChildIds = [...new Set(allChildVariantIds)];
    let childVariantMap = {};
    if (uniqueChildIds.length > 0) {
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
              qtyManagementMetafield: metafield(
                namespace: "projektstocksyncqtymanagement"
                key: "qtymanagement"
              ) {
                id
                value
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

    // Attach fetched child variant data to their master variants.
    const finalProducts = productsParsed.map((product) => {
      const newEdges = product.variants.edges.map((edge) => {
        const variant = edge.node;
        const resolvedChildren = variant.childVariantIds
          .map((id) => childVariantMap[id])
          .filter(Boolean);
        return { node: { ...variant, childVariants: resolvedChildren } };
      });
      return { ...product, variants: { edges: newEdges } };
    });

    /**
     * Only return products that have at least one master variant.
     * For each product, we also filter out any variants that aren't master.
     */
    const onlyMasterProducts = finalProducts
      .map((p) => {
        const masterVariantEdges = p.variants.edges.filter((ve) => ve.node.isMaster);
        if (masterVariantEdges.length > 0) {
          return {
            ...p,
            variants: { edges: masterVariantEdges },
          };
        }
        return null;
      })
      .filter(Boolean);

    return json({ products: onlyMasterProducts });
  } catch (error) {
    console.error("Loader error:", error);
    return json({ products: [], error: error.message }, { status: 500 });
  }
};

/**
 * ProductsTable component:
 * Renders a table of products that have master variants only, along with those
 * master variants and their child variants (if any). This includes the following:
 *
 * - A search bar to filter products by their title.
 * - Pagination that displays up to 10 products per page.
 * - Expandable product rows to reveal the variant rows.
 * - Within each master variant row, an additional expansion can show its child variants.
 * - Facilities to manage child assignments and master variant inventory.
 * - Toast notifications for feedback on important actions.
 *
 * This version exclusively displays master variants for each product (where
 * `masterMetafield?.value === "true"`).
 */
export default function ProductsTable() {
  // Prevent rendering on the server side.
  if (typeof window === "undefined") return null;

  const { products: initialProducts } = useLoaderData();
  const revalidator = useRevalidator();

  // Include custom CSS to ensure our 'activeRow' style is honoured.
  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
      .activeRow {
        background-color: #cceeff !important;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // State for products and their variations.
  const [products, setProducts] = useState(initialProducts);
  useEffect(() => setProducts(initialProducts), [initialProducts]);

  // State for searching, sorting, and pagination.
  const [query, setQuery] = useState("");
  const [sortValue, setSortValue] = useState("title");
  const [sortDirection, setSortDirection] = useState("ascending");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;

  // State for expansion of product rows.
  const [expandedProductIndex, setExpandedProductIndex] = useState(-1);
  // For master variants: track which are expanded so we can toggle their background.
  const [expandedMasters, setExpandedMasters] = useState([]);

  // State for modals and selected product or variant contexts.
  const [modalActive, setModalActive] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [childrenModalActive, setChildrenModalActive] = useState(false);

  // State for inventory adjustments.
  const [inventory, setInventory] = useState({});
  // Flattened list of all variants, useful for searching and child assignments.
  const [allVariants, setAllVariants] = useState([]);
  // State for children selection in the child assignment modal.
  const [childrenSelection, setChildrenSelection] = useState([]);

  // State for toast notifications.
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  // State for child variant quantity management.
  const [qtyManagementValues, setQtyManagementValues] = useState({});

  // State for children modal search and pagination.
  const [childrenQuery, setChildrenQuery] = useState("");
  const [childrenCurrentPage, setChildrenCurrentPage] = useState(1);
  const childrenItemsPerPage = 5;

  // Compute filtered total for pagination.
  const totalProducts = products
    .filter((product) =>
      product.title.toLowerCase().includes(query.toLowerCase())
    ).length;
  const startIndex = (currentPage - 1) * itemsPerPage + 1;
  const endIndex = Math.min(totalProducts, currentPage * itemsPerPage);

  // Build a list of all variants (from all products) to assist with child management.
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

  // Filter, sort, and paginate the product array.
  const filteredProducts = products.filter((product) =>
    product.title.toLowerCase().includes(query.toLowerCase())
  );
  const sortedProducts = [...filteredProducts].sort((a, b) => {
    if (sortValue === "title") {
      const result = a.title.localeCompare(b.title);
      return sortDirection === "ascending" ? result : -result;
    }
    return 0;
  });
  const paginatedProducts = sortedProducts.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Sorting callback.
  const handleSort = useCallback((newSortValue, newSortDirection) => {
    setSortValue(newSortValue);
    setSortDirection(newSortDirection);
  }, []);

  // Toggle expansion for a product row.
  const toggleExpanded = useCallback(
    (index) => () => {
      setExpandedProductIndex((prev) => (prev === index ? -1 : index));
    },
    []
  );

  // Toggle the expansion for a master variant row, revealing its child variants.
  const toggleMasterVariant = (variantId) => {
    setExpandedMasters((prev) =>
      prev.includes(variantId)
        ? prev.filter((id) => id !== variantId)
        : [...prev, variantId]
    );
  };

  // Helper to identify which master variant, if any, a given child belongs to.
  function findMasterOfVariant(variantId) {
    for (const prod of products) {
      for (const ve of prod.variants.edges) {
        const possibleMaster = ve.node;
        if (possibleMaster.isMaster && possibleMaster.childVariantIds?.includes(variantId)) {
          return {
            masterVariant: possibleMaster,
            masterProductId: prod.id,
            masterProductTitle: prod.title,
          };
        }
      }
    }
    return null;
  }

  // Determine if a variant's master checkbox should be disabled
  // because it's already assigned as a child to some other master.
  const isVariantAssignedElsewhere = (variant, currentProductId) => {
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== currentProductId;
  };

  // A separate check for the child assignment modal, ensuring a variant
  // isn't assigned to another master.
  const isChildVariantAssignedElsewhere = (variant) => {
    if (!selectedProduct) return false;
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== selectedProduct.id;
  };

  // Toast notification helpers.
  function showToast(message) {
    setToastMessage(message);
    setToastActive(true);
  }
  function onDismissToast() {
    setToastActive(false);
    setToastMessage("");
  }

  // Open the inventory modal for a given master variant.
  function openMasterInventoryModal(product, masterVariant) {
    setSelectedProduct(product);
    setSelectedVariant(masterVariant);
    setInventory({ [masterVariant.id]: masterVariant.inventoryQuantity });
    setModalActive(true);
  }

  // Toggle the child assignment modal on or off.
  function toggleChildrenModal() {
    setChildrenModalActive((prev) => !prev);
  }

  // Open the child assignment modal, provided we have a valid master variant.
  function openChildrenModal(product, variant) {
    if (!variant.isMaster) {
      showToast("Cannot manage children: this variant is not designated as Master.");
      return;
    }
    setSelectedProduct(product);
    setSelectedVariant(variant);
    setChildrenSelection(variant.childVariantIds || []);
    setChildrenQuery("");
    setChildrenCurrentPage(1);
    toggleChildrenModal();
  }

  // Toggle a child's selection in the child assignment modal.
  function handleToggleChildSelection(variantGid) {
    setChildrenSelection((prev) =>
      prev.includes(variantGid)
        ? prev.filter((id) => id !== variantGid)
        : [...prev, variantGid]
    );
  }

  // Save the child assignments for the current master variant.
  function handleSaveChildren() {
    if (!selectedVariant) return;

    // Check for invalid child assignments (e.g., child is itself a master or assigned elsewhere).
    const invalidChildren = [];
    childrenSelection.forEach((childId) => {
      const childData = allVariants.find((v) => v.id === childId);
      if (!childData) return;

      if (childData.isMaster) {
        invalidChildren.push({
          childId,
          reason: `Variant ${parseVariantId(childId)} is a Master variant and cannot be assigned as a child.`,
        });
        return;
      }

      const foundMaster = findMasterOfVariant(childId);
      if (foundMaster && foundMaster.masterVariant.id !== selectedVariant.id) {
        invalidChildren.push({
          childId,
          reason: `Variant ${parseVariantId(childId)} is already a child of '${foundMaster.masterProductTitle}'.`,
        });
      }
    });

    if (invalidChildren.length > 0) {
      showToast(`Cannot save children. ${invalidChildren[0].reason}`);
      return;
    }

    // If valid, update the children on the server.
    handleAddChildren(selectedVariant.id, childrenSelection);
    toggleChildrenModal();
  }

  // Update the 'master' metafield on the server.
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
        throw new Error("Failed to update the 'master' metafield");
      }
    } catch (error) {
      console.error("Error updating 'master' metafield:", error);
      throw error;
    }
  }

  // Handle the change for a variant's master checkbox in the UI, sending updates to the server.
  async function handleMasterCheckboxChange(productId, variantId, newChecked) {
    if (newChecked) {
      const foundMaster = findMasterOfVariant(variantId);
      if (foundMaster) {
        showToast(`Cannot set as master. This variant is already a child of '${foundMaster.masterProductTitle}'.`);
        return;
      }
    }
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

    try {
      await updateMasterMetafield(variantId, newChecked);
    } catch (error) {
      console.error("Failed to update master metafield on server:", error);

      // Revert the state if there's an error.
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

  // Update the 'childrenkey' metafield with the chosen child variants.
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
      if (!response.ok) throw new Error("Failed to update childrenkey");
      // Update local state.
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
      revalidator.revalidate();
    } catch (error) {
      console.error("Error updating childrenkey:", error);
    }
  }

  // Local state management for inventory changes.
  function handleInventoryChange(variantId, newQuantity) {
    setInventory((prev) => ({ ...prev, [variantId]: newQuantity }));
  }

  // Persist the updated inventory to the server.
  async function updateInventory() {
    if (!selectedProduct || !selectedVariant) return;
    try {
      const variantId = selectedVariant.id;
      const qty = inventory[variantId];
      await fetch("/api/update-inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId, newQuantity: Number(qty) }),
      });
      // Update local state for consistency.
      setProducts((prev) =>
        prev.map((prod) => {
          if (prod.id !== selectedProduct.id) return prod;
          const newEdges = prod.variants.edges.map((edge) =>
            edge.node.id === variantId
              ? { ...edge, node: { ...edge.node, inventoryQuantity: Number(qty) } }
              : edge
          );
          return { ...prod, variants: { edges: newEdges } };
        })
      );
      setModalActive(false);
      revalidator.revalidate();
    } catch (error) {
      console.error("Error updating inventory:", error);
    }
  }

  // Update the quantity management metafield on the server for a child variant.
  async function updateQtyManagement(variantId, newQty) {
    try {
      const response = await fetch("/api/update-variant-metafield", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId,
          namespace: "projektstocksyncqtymanagement",
          key: "qtymanagement",
          value: String(parseInt(newQty, 10)),
        }),
      });
      if (!response.ok) {
        throw new Error("Failed to update the qty management metafield");
      }
      showToast(`Quantity management updated for variant ${parseVariantId(variantId)}`);
    } catch (error) {
      console.error("Error updating qty management metafield:", error);
      showToast(`Error updating quantity management for variant ${parseVariantId(variantId)}`);
    }
  }

  /**
   * getVariantStatus:
   * Determines whether a variant is Master, Child, or Unassigned, returning
   * both a label and a recommended background colour.
   *
   * For Master variants:
   * - The default background is a dark grey (#333333).
   * - If expanded in the UI (variant ID is in expandedMasters), it uses a light-blue highlight (#cceeff).
   *
   * For Child variants, a pale orange background (#fff4e5) is used to differentiate them.
   */
  function getVariantStatus(variant) {
    let status = "";
    if (variant.isMaster) {
      status = "Master";
    } else if (findMasterOfVariant(variant.id)) {
      status = "Child";
    } else {
      status = "Unassigned";
    }

    let bgColour = "#ffffff"; // default for unassigned
    if (status === "Master") {
      bgColour = "#333333"; // default dark grey for master
      if (expandedMasters.includes(variant.id)) {
        bgColour = "#cceeff"; // highlight if expanded
      }
    } else if (status === "Child") {
      bgColour = "#fff4e5";
    }
    return { status, bgColour };
  }

  return (
    <Frame>
      <Page>
        {/*
          Title bar with optional actions (for demonstration).
          You could customise or remove these as needed.
        */}
        <TitleBar title="All Products with Master Variants">
          <button variant="primary" url="/app/products/">
            Full Product List
          </button>
        </TitleBar>

        {/* Main card containing the search bar and the index table. */}
        <Card padding="0">
          <Box paddingBlock="300" paddingInline="200" marginBottom="200">
            <TextField
              label=""
              placeholder="Search by product title"
              value={query}
              onChange={(value) => {
                setQuery(value);
                setCurrentPage(1);
              }}
              autoComplete="off"
              connectedLeft={<Icon source={SearchIcon} color="subdued" />}
              connectedRight={
                query ? (
                  <Button
                    plain
                    icon={XCircleIcon}
                    onClick={() => {
                      setQuery("");
                      setCurrentPage(1);
                    }}
                  />
                ) : null
              }
            />
          </Box>

          <IndexTable
            headings={[
              { title: "Image" },
              {
                title: "Details",
                sortable: true,
                onSort: handleSort,
                sortDirection: sortValue === "title" ? sortDirection : undefined,
              },
              { title: "Status" },
              { title: "Inventory" },
              { title: "Master" },
              { title: "Actions" },
            ]}
            itemCount={paginatedProducts.length}
            selectable={false}
          >
            {paginatedProducts.map((product, productIndex) => {
              const isProductExpanded = expandedProductIndex === productIndex;

              // Parent-level product row
              const productRowMarkup = (
                <IndexTable.Row
                  rowType="data"
                  id={product.id}
                  key={product.id}
                  position={productIndex}
                  onClick={toggleExpanded(productIndex)}
                  style={{ backgroundColor: isProductExpanded ? "#e6e6e6" : "#ffffff" }}
                >
                  <IndexTable.Cell>
                    <Thumbnail
                      source={product.images.edges[0]?.node.originalSrc || ""}
                      alt={product.title}
                    />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                      <div style={{ display: "inline-block", maxWidth: "fit-content", whiteSpace: "nowrap" }}>
                        <Tag>{product.variants.edges.length} variants</Tag>
                      </div>
                      <Text as="span" variant="headingMd" fontWeight="semibold">
                        {product.title}
                      </Text>
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell />
                  <IndexTable.Cell />
                  <IndexTable.Cell />
                  <IndexTable.Cell />
                </IndexTable.Row>
              );

              // Nested rows: each variant (in this scenario, only master variants) plus potential child rows.
              let variantSubRows = null;
              if (isProductExpanded) {
                variantSubRows = product.variants.edges.map((variantEdge, variantIndex) => {
                  const variant = variantEdge.node;
                  const { status, bgColour } = getVariantStatus(variant);
                  const shortVariantId = parseVariantId(variant.id);

                  // Master or general variant row
                  const variantRow = (
                    <IndexTable.Row
                      rowType="child"
                      id={`variant-${variant.id}`}
                      key={variant.id}
                      position={productIndex + 1 + variantIndex}
                      onClick={(e) => {
                        if (e?.stopPropagation) e.stopPropagation();
                        if (variant.isMaster) toggleMasterVariant(variant.id);
                      }}
                      className={variant.isMaster && expandedMasters.includes(variant.id) ? "activeRow" : ""}
                      style={{ backgroundColor: bgColour }}
                    >
                      <IndexTable.Cell>
                        <Thumbnail
                          source={variant.image?.originalSrc || product.images.edges[0]?.node.originalSrc || ""}
                          size="small"
                          alt={variant.title}
                        />
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                          {variant.isMaster ? (
                            <div style={{ display: "inline-block", maxWidth: "fit-content", whiteSpace: "nowrap" }}>
                              <Tag status="success">Variant Master – {shortVariantId}</Tag>
                            </div>
                          ) : (
                            <div style={{ display: "inline-block", maxWidth: "fit-content", whiteSpace: "nowrap" }}>
                              <Tag status={status === "Child" ? "warning" : "default"}>
                                Variant – {shortVariantId}
                              </Tag>
                            </div>
                          )}
                          <Text as="span" variant="headingSm">
                            {variant.title}
                          </Text>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {variant.isMaster ? (
                          <Tag status="success" size="small">
                            Master
                          </Tag>
                        ) : findMasterOfVariant(variant.id) ? (
                          <Tag status="warning" size="small">
                            Child
                          </Tag>
                        ) : (
                          <Tag size="small">Unassigned</Tag>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm">
                          Inventory: {variant.inventoryQuantity ?? 0}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Checkbox
                          checked={variant.isMaster}
                          disabled={!variant.isMaster && isVariantAssignedElsewhere(variant, product.id)}
                          onChange={(checked) =>
                            handleMasterCheckboxChange(product.id, variant.id, checked)
                          }
                        />
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <Button
                            primary
                            onClick={(e) => {
                              e.stopPropagation();
                              openChildrenModal(product, variant);
                            }}
                          >
                            Manage Children
                          </Button>
                          <Button
                            onClick={(e) => {
                              e.stopPropagation();
                              openMasterInventoryModal(product, variant);
                            }}
                          >
                            Edit Inventory
                          </Button>
                        </div>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );

                  // Render the child variant rows if this master variant is expanded.
                  const childVariantRows =
                    variant.isMaster &&
                    variant.childVariants?.length > 0 &&
                    expandedMasters.includes(variant.id)
                      ? variant.childVariants.map((childVar, childIndex) => {
                          const shortChildId = parseVariantId(childVar.id);
                          const currentQtyValue =
                            qtyManagementValues[childVar.id] !== undefined
                              ? qtyManagementValues[childVar.id]
                              : childVar.qtyManagementMetafield?.value ?? "";
                          const childBgColour = "#575757";
                          return (
                            <IndexTable.Row
                              rowType="child"
                              id={`childVar-${childVar.id}`}
                              key={childVar.id}
                              position={productIndex + 2 + variantIndex + childIndex}
                              style={{ backgroundColor: childBgColour }}
                            >
                              <IndexTable.Cell>
                                <Thumbnail
                                  source={
                                    childVar.image?.originalSrc ||
                                    childVar.product?.images?.edges?.[0]?.node.originalSrc ||
                                    ""
                                  }
                                  alt={childVar.product?.title || "Untitled"}
                                  size="small"
                                />
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                                  <div
                                    style={{
                                      display: "inline-block",
                                      maxWidth: "fit-content",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    <Tag status="warning">Variant – {shortChildId}</Tag>
                                  </div>
                                  <Text as="span" variant="headingSm">
                                    {childVar.product?.title || "Untitled"}
                                  </Text>
                                </div>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Tag status="warning" size="small">
                                  Child
                                </Tag>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Text as="span" variant="bodySm" fontWeight="bold">
                                  Stock: {childVar.inventoryQuantity ?? 0}
                                </Text>
                              </IndexTable.Cell>
                              <IndexTable.Cell />
                              <IndexTable.Cell>
                                <div
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "flex-start",
                                  }}
                                >
                                  <Text
                                    as="span"
                                    variant="bodySm"
                                    fontWeight="bold"
                                    style={{ marginBottom: "0.5rem" }}
                                  >
                                    Child Times
                                  </Text>
                                  <TextField
                                    label=""
                                    placeholder="Qty"
                                    type="number"
                                    value={currentQtyValue}
                                    onChange={(value) =>
                                      setQtyManagementValues((prev) => ({
                                        ...prev,
                                        [childVar.id]: value,
                                      }))
                                    }
                                    onBlur={() =>
                                      updateQtyManagement(
                                        childVar.id,
                                        qtyManagementValues[childVar.id] !== undefined
                                          ? qtyManagementValues[childVar.id]
                                          : currentQtyValue
                                      )
                                    }
                                    style={{ width: "80px" }}
                                  />
                                </div>
                              </IndexTable.Cell>
                            </IndexTable.Row>
                          );
                        })
                      : null;

                  return (
                    <React.Fragment key={variant.id}>
                      {variantRow}
                      {childVariantRows}
                    </React.Fragment>
                  );
                });
              }

              return (
                <React.Fragment key={product.id}>
                  {productRowMarkup}
                  {variantSubRows}
                </React.Fragment>
              );
            })}
          </IndexTable>

          {/* Table pagination controls */}
          <Pagination
            onPrevious={() => setCurrentPage((prev) => prev - 1)}
            onNext={() => setCurrentPage((prev) => prev + 1)}
            type="table"
            hasPrevious={currentPage > 1}
            hasNext={currentPage < Math.ceil(totalProducts / itemsPerPage)}
            label={`${startIndex}-${endIndex} of ${totalProducts} products`}
          />
        </Card>
      </Page>

      {/* Modal for editing the inventory of a master variant */}
      {modalActive && selectedProduct && selectedVariant && (
        <Modal
          open={modalActive}
          onClose={() => setModalActive(false)}
          title={`Editing Inventory – ${selectedVariant.title}`}
          primaryAction={{ content: "Save Inventory", onAction: updateInventory }}
          secondaryActions={[{ content: "Close", onAction: () => setModalActive(false) }]}
        >
          <Modal.Section>
            <TextContainer>
              <p>
                Please adjust the inventory for the master variant “{selectedVariant.title}” below:
              </p>
            </TextContainer>
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ display: "inline-block", maxWidth: "fit-content", whiteSpace: "nowrap" }}>
                <Tag>Master: {selectedVariant.title}</Tag>
              </div>
              <p>ID: {parseVariantId(selectedVariant.id)}</p>
              <TextField
                label="Inventory Quantity"
                type="number"
                value={String(inventory[selectedVariant.id] ?? "")}
                onChange={(value) => handleInventoryChange(selectedVariant.id, value)}
              />
            </div>
          </Modal.Section>
        </Modal>
      )}

      {/* Modal for assigning children to a master variant */}
      {childrenModalActive && selectedVariant && selectedProduct && (
        <Modal
          open={childrenModalActive}
          onClose={toggleChildrenModal}
          title={`Manage Children for Master Variant ${parseVariantId(selectedVariant.id)}`}
          primaryAction={{ content: "Save Children", onAction: handleSaveChildren }}
          secondaryActions={[{ content: "Cancel", onAction: toggleChildrenModal }]}
        >
          <Modal.Section>
            <TextContainer>
              <p>
                Please select which variants should be assigned as children for this master variant. Current selections are pre-checked.
              </p>
            </TextContainer>
            <Box paddingBlock="2">
              <TextField
                label="Search Children"
                value={childrenQuery}
                onChange={(value) => {
                  setChildrenQuery(value);
                  setChildrenCurrentPage(1);
                }}
                placeholder="Search by variant title"
              />
            </Box>
            {allVariants.length === 0 && <Spinner accessibilityLabel="Loading" />}
            {allVariants.length > 0 && (
              <ResourceList
                resourceName={{ singular: "variant", plural: "variants" }}
                items={allVariants
                  .filter(
                    (v) =>
                      v.id !== selectedVariant.id &&
                      (v.title.toLowerCase().includes(childrenQuery.toLowerCase()) ||
                        v.productTitle.toLowerCase().includes(childrenQuery.toLowerCase()))
                  )
                  .slice(
                    (childrenCurrentPage - 1) * childrenItemsPerPage,
                    childrenCurrentPage * childrenItemsPerPage
                  )}
                renderItem={(item) => {
                  const shortId = parseVariantId(item.id);
                  const media = (
                    <Thumbnail
                      source={item.image?.originalSrc || item.productImage || ""}
                      size="small"
                      alt={item.title}
                    />
                  );
                  const isChecked = childrenSelection.includes(item.id);
                  const disabledCheckbox = isChildVariantAssignedElsewhere(item);

                  return (
                    <ResourceItem
                      id={item.id}
                      media={media}
                      accessibilityLabel={`Select ${item.title}`}
                    >
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <Checkbox
                          checked={isChecked}
                          disabled={disabledCheckbox}
                          onChange={() => handleToggleChildSelection(item.id)}
                        />
                        <div style={{ marginLeft: "1rem" }}>
                          <div style={{ display: "inline-block", maxWidth: "fit-content", whiteSpace: "nowrap" }}>
                            <Tag>
                              {item.productTitle} – Variant: {item.title}
                            </Tag>
                          </div>
                          <p>ID: {shortId}</p>
                        </div>
                      </div>
                    </ResourceItem>
                  );
                }}
              />
            )}
            <Box paddingBlock="2">
              <Pagination
                hasPrevious={childrenCurrentPage > 1}
                onPrevious={() => setChildrenCurrentPage((prev) => prev - 1)}
                hasNext={
                  childrenCurrentPage <
                  Math.ceil(
                    allVariants.filter(
                      (v) =>
                        v.id !== selectedVariant.id &&
                        (v.title.toLowerCase().includes(childrenQuery.toLowerCase()) ||
                          v.productTitle.toLowerCase().includes(childrenQuery.toLowerCase()))
                    ).length / childrenItemsPerPage
                  )
                }
                onNext={() => setChildrenCurrentPage((prev) => prev + 1)}
              />
            </Box>
          </Modal.Section>
        </Modal>
      )}

      {/* Toast notifications */}
      {toastActive && (
        <Toast content={toastMessage} onDismiss={onDismissToast} error />
      )}
    </Frame>
  );
}
