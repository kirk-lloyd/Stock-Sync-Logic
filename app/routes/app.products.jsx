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
 * For example, "gid://shopify/ProductVariant/12345" returns "12345".
 */
function parseVariantId(gid = "") {
  return gid.split("/").pop();
}

/**
 * Loader function:
 * Authenticates with Shopify and retrieves products along with their variants and associated metafields.
 * It identifies master variants and collects child variant IDs, then queries for additional details of the child variants,
 * including the quantity management metafield.
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

    // Identify master variants and collect child variant IDs.
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

    // Fetch additional data for child variants (including quantity management metafield).
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
        if (childVariant?.id) childVariantMap[childVariant.id] = childVariant;
      });
    }

    // Attach fetched child variant data to each master variant.
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
 * Renders a table of products and their variants with a search bar inside the Card.
 * The search bar filters products by title.
 * Table pagination is applied at the product level (10 items per page) using a table-style pagination.
 * Clicking a product row expands the nested rows.
 * Clicking a master variant toggles the display of its nested child variant rows.
 * Master variant rows include actions to manage children and edit inventory.
 */
export default function ProductsTable() {
  if (typeof window === "undefined") return null;

  const { products: initialProducts } = useLoaderData();
  const revalidator = useRevalidator();

  // Primary state for products.
  const [products, setProducts] = useState(initialProducts);
  useEffect(() => setProducts(initialProducts), [initialProducts]);

  // State for search, sorting, and pagination.
  const [query, setQuery] = useState("");
  const [sortValue, setSortValue] = useState("title");
  const [sortDirection, setSortDirection] = useState("ascending");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // State for expanded rows.
  const [expandedProductIndex, setExpandedProductIndex] = useState(-1);
  // Expanded master variants (IDs) to control nested children display
  const [expandedMasters, setExpandedMasters] = useState([]);
  const [modalActive, setModalActive] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [childrenModalActive, setChildrenModalActive] = useState(false);
  const [inventory, setInventory] = useState({});
  const [allVariants, setAllVariants] = useState([]);
  const [childrenSelection, setChildrenSelection] = useState([]);
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [qtyManagementValues, setQtyManagementValues] = useState({});

  // State for the children management modal search and pagination.
  const [childrenQuery, setChildrenQuery] = useState("");
  const [childrenCurrentPage, setChildrenCurrentPage] = useState(1);
  const childrenItemsPerPage = 5;

  // Compute pagination indexes.
  const totalProducts = products
    .filter((product) =>
      product.title.toLowerCase().includes(query.toLowerCase())
    )
    .length;
  const startIndex = (currentPage - 1) * itemsPerPage + 1;
  const endIndex = Math.min(totalProducts, currentPage * itemsPerPage);

  // Build a flattened list of all variants.
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

  // Compute filtered, sorted, and paginated products.
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

  // Handle sorting when clicking a header.
  const handleSort = useCallback((newSortValue, newSortDirection) => {
    setSortValue(newSortValue);
    setSortDirection(newSortDirection);
  }, []);

  // Toggle product row expansion.
  const toggleExpanded = useCallback(
    (index) => () => setExpandedProductIndex((prev) => (prev === index ? -1 : index)),
    []
  );

  // Toggle master variant expansion to show/hide child rows.
  const toggleMasterVariant = (variantId) => {
    setExpandedMasters((prev) =>
      prev.includes(variantId)
        ? prev.filter((id) => id !== variantId)
        : [...prev, variantId]
    );
  };

  // Helper: returns the master variant for a given child variant.
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

  // Determines whether a variant's checkbox should be disabled.
  const isVariantAssignedElsewhere = (variant, currentProductId) => {
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== currentProductId;
  };

  // For the children modal checkboxes, disable if the variant is already assigned elsewhere.
  const isChildVariantAssignedElsewhere = (variant) => {
    if (!selectedProduct) return false;
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== selectedProduct.id;
  };

  function showToast(message) {
    setToastMessage(message);
    setToastActive(true);
  }
  function onDismissToast() {
    setToastActive(false);
    setToastMessage("");
  }

  // INVENTORY MODAL FUNCTIONS
  function openMasterInventoryModal(product, masterVariant) {
    setSelectedProduct(product);
    setSelectedVariant(masterVariant);
    setInventory({ [masterVariant.id]: masterVariant.inventoryQuantity });
    setModalActive(true);
  }

  // CHILDREN MANAGEMENT MODAL FUNCTIONS
  function toggleChildrenModal() {
    setChildrenModalActive((prev) => !prev);
  }
  function openChildrenModal(product, variant) {
    if (!variant.isMaster) {
      showToast("Cannot manage children: this variant is not designated as Master.");
      return;
    }
    setSelectedProduct(product);
    setSelectedVariant(variant);
    setChildrenSelection(variant.childVariantIds || []);
    // Reset the modal search and pagination state.
    setChildrenQuery("");
    setChildrenCurrentPage(1);
    toggleChildrenModal();
  }
  function handleToggleChildSelection(variantGid) {
    setChildrenSelection((prev) =>
      prev.includes(variantGid)
        ? prev.filter((id) => id !== variantGid)
        : [...prev, variantGid]
    );
  }
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

  function handleInventoryChange(variantId, newQuantity) {
    setInventory((prev) => ({ ...prev, [variantId]: newQuantity }));
  }

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

  // Determines the status and corresponding row background colour.
  function getVariantStatus(variant) {
    let status = "";
    if (variant.isMaster) {
      status = "Master";
    } else if (findMasterOfVariant(variant.id)) {
      status = "Child";
    } else {
      status = "Unassigned";
    }

    let bgColour = "#ffffff"; // Default for unassigned.
    if (status === "Master") bgColour = "#333333"; // Dark background for master.
    else if (status === "Child") bgColour = "#fff4e5"; // Pale orange for child.

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
          {/* Search bar with padding, left icon and clear button */}
          <Box paddingBlock="6" paddingInline="6" marginBottom="10">
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
              const isProductExpanded = expandedProductIndex === productIndex;
  
              // Parent row for the product
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
                      <Tag style={{ display: "inline-block", width: "auto" }}>
                        {product.variants.edges.length} variants
                      </Tag>
                      <Text as="span" variant="headingMd" fontWeight="semibold">
                        {product.title}
                      </Text>
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{/* Status column */}</IndexTable.Cell>
                  <IndexTable.Cell>{/* Inventory column */}</IndexTable.Cell>
                  <IndexTable.Cell>{/* Master column */}</IndexTable.Cell>
                  <IndexTable.Cell>{/* Actions column */}</IndexTable.Cell>
                </IndexTable.Row>
              );
  
              let variantSubRows = null;
              if (isProductExpanded) {
                variantSubRows = product.variants.edges.map((variantEdge, variantIndex) => {
                  const variant = variantEdge.node;
                  const { status, bgColour } = getVariantStatus(variant);
                  const shortVariantId = parseVariantId(variant.id);
  
                  // Render the master variant row (or normal variant row)
                  const variantRow = (
                    <IndexTable.Row
                      rowType="child"
                      id={`variant-${variant.id}`}
                      key={variant.id}
                      position={productIndex + 1 + variantIndex}
                      onClick={(e) => {
                        if (e && typeof e.stopPropagation === "function") {
                          e.stopPropagation();
                        }
                        if (variant.isMaster) toggleMasterVariant(variant.id);
                      }}
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
                            <Tag status="success" style={{ display: "inline-block", width: "auto" }}>
                              Variant Master – {shortVariantId}
                            </Tag>
                          ) : (
                            <Tag status={status === "Child" ? "warning" : "default"} style={{ display: "inline-block", width: "auto" }}>
                              Variant – {shortVariantId}
                            </Tag>
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
                          <Tag size="small">
                            Unassigned
                          </Tag>
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
  
                  // Conditionally render nested child rows only if the master variant is expanded.
                  const childVariantRows =
                    variant.isMaster && variant.childVariants?.length > 0 && expandedMasters.includes(variant.id)
                      ? variant.childVariants.map((childVar, childIndex) => {
                          const shortChildId = parseVariantId(childVar.id);
                          const currentQtyValue =
                            qtyManagementValues[childVar.id] !== undefined
                              ? qtyManagementValues[childVar.id]
                              : childVar.qtyManagementMetafield?.value ?? "";
                          const childBgColour = "#fff4e5";
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
                                  source={childVar.image?.originalSrc || childVar.product?.images?.edges?.[0]?.node.originalSrc || ""}
                                  alt={childVar.product?.title || "Untitled"}
                                  size="small"
                                />
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                                  <Tag status="warning" style={{ display: "inline-block", width: "auto" }}>
                                    Variant – {shortChildId}
                                  </Tag>
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
              <Tag style={{ display: "inline-block", width: "auto" }}>
                Master: {selectedVariant.title}
              </Tag>
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
                          <Tag style={{ display: "inline-block", width: "auto" }}>
                            {item.productTitle} – Variant: {item.title}
                          </Tag>
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
