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
 * Extracts the numeric part from a Shopify GID string.
 * E.g., "gid://shopify/ProductVariant/12345" returns "12345".
 */
function parseVariantId(gid = "") {
  return gid.split("/").pop();
}

/**
 * Loader function:
 * Authenticates with Shopify and retrieves products along with their variants and metafields.
 * For each product, it determines which variants are "master" variants and parses their
 * childrenMetafield to obtain an array of child variant IDs.
 * Then it fetches additional details for each unique child variant and attaches those
 * details to their corresponding master variant.
 */
export const loader = async ({ request }) => {
  console.log("Loader start: Authenticating and retrieving products…");
  const { admin } = await authenticate.admin(request);

  try {
    // ================================================
    // 1) FETCH ALL PRODUCTS USING CURSOR-BASED PAGINATION
    // ================================================
    let allProducts = [];
    let hasNextPage = true;
    let endCursor = null;
    const pageSize = 100;

    while (hasNextPage) {
      // A single "page" of products
      const productQuery = `
        query GetAllProducts($pageSize: Int!, $cursor: String) {
          products(first: $pageSize, after: $cursor) {
            edges {
              cursor
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
                variants(first: 100) {
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
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const response = await admin.graphql(productQuery, {
        variables: {
          pageSize,
          cursor: endCursor,
        },
      });
      const data = await response.json();

      // Collect this "page" of products
      const edges = data?.data?.products?.edges ?? [];
      edges.forEach((edge) => allProducts.push(edge.node));

      // Check for next page
      hasNextPage = data?.data?.products?.pageInfo?.hasNextPage || false;
      endCursor = data?.data?.products?.pageInfo?.endCursor || null;
    }

    // ================================================
    // 2) POST-PROCESS PRODUCTS: DETERMINE MASTERS & CHILDREN
    // ================================================
    let allChildVariantIds = [];
    const productsParsed = allProducts.map((product) => {
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

    // ================================================
    // 3) FETCH CHILD VARIANTS (IF ANY)
    // ================================================
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

    // ================================================
    // 4) ATTACH CHILD VARIANTS TO THEIR MASTERS
    // ================================================
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

    return json({ products: finalProducts });
  } catch (error) {
    console.error("Loader error:", error);
    return json({ products: [], error: error.message }, { status: 500 });
  }
};

/**
 * ProductsTable Component:
 * Renders a table of products and their variants.
 *
 * - A search bar inside the Card filters products by title.
 * - Table pagination displays 20 products per page.
 * - Clicking a product row toggles its expansion.
 * - Each product (parent row) is rendered with rowType="data".
 * - For each product, its variants are rendered as nested rows (rowType="child").
 * - For master variants, clicking the row toggles the display of its nested child rows.
 * - When a master variant is expanded, its background remains active via a custom CSS class.
 * - Inventory and children management modals are provided.
 */
export default function ProductsTable() {
  if (typeof window === "undefined") return null;

  const { products: initialProducts } = useLoaderData();
  const revalidator = useRevalidator();

  // Add custom CSS to force active background color
  // This style ensures that rows with the "activeRow" class have the desired background colour.
  // The !important flag is used to override any Polaris defaults.
  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
      .activeRow {
        background-color:rgb(173, 173, 173) !important;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // State for products.
  const [products, setProducts] = useState(initialProducts);
  useEffect(() => setProducts(initialProducts), [initialProducts]);

  // State for search, sorting and pagination.
  const [query, setQuery] = useState("");
  const [sortValue, setSortValue] = useState("title");
  const [sortDirection, setSortDirection] = useState("ascending");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;

  // State for row expansion.
  const [expandedProductIndex, setExpandedProductIndex] = useState(-1);
  // For master variants: store IDs of expanded rows to maintain active background.
  const [expandedMasters, setExpandedMasters] = useState([]);

  // State for modals and selected product/variant.
  const [modalActive, setModalActive] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [childrenModalActive, setChildrenModalActive] = useState(false);

  // State for inventory, variants reference and toast notifications.
  const [inventory, setInventory] = useState({});
  const [allVariants, setAllVariants] = useState([]);
  const [childrenSelection, setChildrenSelection] = useState([]);
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [qtyManagementValues, setQtyManagementValues] = useState({});

  // State for children management modal search and pagination.
  const [childrenQuery, setChildrenQuery] = useState("");
  const [childrenCurrentPage, setChildrenCurrentPage] = useState(1);
  const childrenItemsPerPage = 5;

  // Compute pagination indexes based on filtered products.
  const totalProducts = products
    .filter((product) =>
      product.title.toLowerCase().includes(query.toLowerCase())
    )
    .length;
  const startIndex = (currentPage - 1) * itemsPerPage + 1;
  const endIndex = Math.min(totalProducts, currentPage * itemsPerPage);

  // Build a flattened list of all variants (used in modals, etc.).
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

  // Filter, sort and paginate products.
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

  // Handler for sorting when a header is clicked.
  const handleSort = useCallback((newSortValue, newSortDirection) => {
    setSortValue(newSortValue);
    setSortDirection(newSortDirection);
  }, []);

  // Toggle expansion for a product row (parent row).
  const toggleExpanded = useCallback(
    (index) => () => setExpandedProductIndex((prev) => (prev === index ? -1 : index)),
    []
  );

  // Toggle expansion for a master variant row to show/hide nested child rows.
  const toggleMasterVariant = (variantId) => {
    setExpandedMasters((prev) =>
      prev.includes(variantId)
        ? prev.filter((id) => id !== variantId)
        : [...prev, variantId]
    );
  };

  // Helper function to find the master variant for a given child variant.
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

  // Check if a variant's checkbox should be disabled (e.g. if it's already assigned elsewhere).
  const isVariantAssignedElsewhere = (variant, currentProductId) => {
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== currentProductId;
  };

  // For children modal checkboxes, disable if the variant is already assigned elsewhere.
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

  // Toggle the children management modal.
  function toggleChildrenModal() {
    setChildrenModalActive((prev) => !prev);
  }
  // Open the children management modal for a master variant.
  function openChildrenModal(product, variant) {
    if (!variant.isMaster) {
      showToast("Cannot manage children: this variant is not designated as Master.");
      return;
    }
    setSelectedProduct(product);
    setSelectedVariant(variant);
    setChildrenSelection(variant.childVariantIds || []);
    // Reset modal search and pagination.
    setChildrenQuery("");
    setChildrenCurrentPage(1);
    toggleChildrenModal();
  }
  // Toggle selection for a child variant in the modal.
  function handleToggleChildSelection(variantGid) {
    setChildrenSelection((prev) =>
      prev.includes(variantGid)
        ? prev.filter((id) => id !== variantGid)
        : [...prev, variantGid]
    );
  }
  // Save children assignments.
  function handleSaveChildren() {
    if (!selectedVariant) return;
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
    handleAddChildren(selectedVariant.id, childrenSelection);
    toggleChildrenModal();
  }

  // Update master metafield on the server.
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
      if (!response.ok) throw new Error("Failed to update the 'master' metafield");
    } catch (error) {
      console.error("Error updating 'master' metafield:", error);
      throw error;
    }
  }

  // Handler for master checkbox changes.
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
      // Revert state change on error.
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

  // Update children metafield on the server.
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

  // Handle inventory changes.
  function handleInventoryChange(variantId, newQuantity) {
    setInventory((prev) => ({ ...prev, [variantId]: newQuantity }));
  }

  // Update inventory on the server.
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

  // Update quantity management metafield.
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
      if (!response.ok) throw new Error("Failed to update the qty management metafield");
      showToast(`Quantity management updated for variant ${parseVariantId(variantId)}`);
    } catch (error) {
      console.error("Error updating qty management metafield:", error);
      showToast(`Error updating quantity management for variant ${parseVariantId(variantId)}`);
    }
  }

  /**
   * getVariantStatus:
   * Determines the status of a variant (Master, Child, or Unassigned) and returns an object
   * containing the status label and background colour.
   *
   * For master variants:
   * - The default background is dark (#333333).
   * - If the master variant is expanded (i.e. its ID is in expandedMasters), it receives the active background (#cceeff).
   * For child variants, a pale orange background (#fff4e5) is used.
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

    // Set default background colour for unassigned.
    let bgColour = "#ffffff";
    if (status === "Master") {
      // Default dark for master.
      bgColour = "#333333";
      // If this master variant is expanded, override with active color.
      if (expandedMasters.includes(variant.id)) {
        bgColour = "#cceeff";
      }
    } else if (status === "Child") {
      bgColour = "#fff4e5";
    }
    return { status, bgColour };
  }

  return (
    <Frame>
      <Page>
        {/* Title bar with action buttons */}
        <TitleBar title="All your products">
          <button variant="primary" url="/app/products/">
            Manage all products 📦
          </button>
          <button variant="secondary" onClick={() => fetcher.submit({}, { method: "POST" })}>
            Master List 👑
          </button>
        </TitleBar>
  
        {/* Card wrapping the search bar and table */}
        <Card padding="0">
          {/* Search bar with padding, left search icon and clear button */}
          <Box paddingBlock="300" paddingInline="300" marginBottom="10">
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
  
          {/* Table of products */}
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
              // Parent product row.
              const isProductExpanded = expandedProductIndex === productIndex;
              const productRowMarkup = (
                <IndexTable.Row
                  rowType="data"
                  id={product.id}
                  key={product.id}
                  position={productIndex}
                  onClick={toggleExpanded(productIndex)}
                  style={{ backgroundColor: isProductExpanded ? "#e6e6e6" : "white" }}
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
                        <Tag>
                          {product.variants.edges.length} variants
                        </Tag>
                      </div>
                      <Text as="span" variant="headingMd" fontWeight="semibold">
                        {product.title}
                      </Text>
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{/* Status */}</IndexTable.Cell>
                  <IndexTable.Cell>{/* Inventory */}</IndexTable.Cell>
                  <IndexTable.Cell>{/* Master */}</IndexTable.Cell>
                  <IndexTable.Cell>{/* Actions */}</IndexTable.Cell>
                </IndexTable.Row>
              );
  
              // For expanded products, render nested variant rows.
              let variantSubRows = null;
              if (isProductExpanded) {
                variantSubRows = product.variants.edges.map((variantEdge, variantIndex) => {
                  const variant = variantEdge.node;
                  const { status, bgColour } = getVariantStatus(variant);
                  const shortVariantId = parseVariantId(variant.id);
  
                  // Master variant row (or regular variant row) as nested row.
                  const variantRow = (
                    <IndexTable.Row
                      rowType="child"
                      id={`variant-${variant.id}`}
                      key={variant.id}
                      position={productIndex + 1 + variantIndex}
                      onClick={(e) => {
                        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
                        if (variant.isMaster) toggleMasterVariant(variant.id);
                      }}
                      // Add the activeRow class if this master variant is expanded.
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
                              <Tag status="success">
                                Variant Master – {shortVariantId}
                              </Tag>
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
  
                  // Render nested child variant rows if the master variant is expanded.
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
                              style={{ background: childBgColour }}
                            >
                              <IndexTable.Cell>
                                <Thumbnail
                                  source={childVar.image?.originalSrc || childVar.product?.images?.edges?.[0]?.node.originalSrc || ""}
                                  alt={childVar.product?.title || "Untitled"}
                                  size="small"
                                />
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                                  <div style={{ display: "inline-block", maxWidth: "fit-content", whiteSpace: "nowrap" }}>
                                    <Tag status="warning">
                                      Variant – {shortChildId}
                                    </Tag>
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
                              <IndexTable.Cell>{/* No checkbox for child variants */}</IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                                  <Text as="span" variant="bodySm" fontWeight="bold" style={{ marginBottom: "0.5rem" }}>
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
  
                  // Return the master variant row and its nested child rows.
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
  
          {/* Table-style pagination */}
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
  
      {/* Inventory Modal */}
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
                <Tag>
                  Master: {selectedVariant.title}
                </Tag>
              </div>
              <p>ID: {parseVariantId(selectedVariant.id)}</p>
              <TextField
                label="Inventory Quantity"
                type="number"
                value={String(inventory[selectedVariant.id] ?? "")}
                onChange={(value) =>
                  handleInventoryChange(selectedVariant.id, value)
                }
              />
            </div>
          </Modal.Section>
        </Modal>
      )}
  
      {/* Children Management Modal */}
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
                  .filter((v) =>
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
                    allVariants.filter((v) =>
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
  
      {toastActive && (
        <Toast content={toastMessage} onDismiss={onDismissToast} error />
      )}
    </Frame>
  );
}