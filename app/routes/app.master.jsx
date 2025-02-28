// app/routes/app.master.jsx
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
  Banner,
} from "@shopify/polaris";
import { SearchIcon, XCircleIcon } from "@shopify/polaris-icons";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server"; // Added to check subscription data
import { TitleBar } from "@shopify/app-bridge-react";
import { Helmet } from "react-helmet";

/**
 * parseVariantId:
 * Australian English Note:
 * This function extracts the numeric part from a Shopify GID string.
 * e.g. "gid://shopify/ProductVariant/12345" returns "12345".
 */
function parseVariantId(gid = "") {
  return gid.split("/").pop();
}

/**
 * Loader function:
 * 1. Authenticates with Shopify using 'authenticate.admin'.
 * 2. Retrieves the store's subscription info from Prisma to ensure the merchant
 *    has an active plan.
 * 3. If the subscription is missing or inactive, we lock the UI (set locked = true).
 * 4. If subscription is active, we proceed to fetch all products with 'master' variants
 *    and attach child variant details. Then we filter out products that have no masters.
 */
export const loader = async ({ request }) => {
  console.log("Loader start: Authenticating and retrieving products…");
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session?.shop;

  if (!shopDomain) {
    // If we have no shop in session, prompt a redirect or throw an error
    return json(
      { products: [], locked: true, reason: "No shop domain in session." },
      { status: 401 }
    );
  }

  // 1) Retrieve the subscription from the DB
  const shopSub = await prisma.shopSubscription.findUnique({
    where: { shop: shopDomain },
  });

  // Determine if the subscription is locked or active
  let locked = false;
  let reason = null;

  if (!shopSub || shopSub.status !== "ACTIVE") {
    locked = true;
    reason = "No active subscription found. Please choose a plan.";
  }

  // If locked, we won't bother fetching products. We'll return an empty array.
  if (locked) {
    return json({
      products: [],
      locked,
      reason,
      plan: shopSub?.plan || "NONE",
      variantsLimit: shopSub?.variantsLimit || 0,
    });
  }

  try {
    // ================================================
    // 2) FETCH ALL PRODUCTS USING CURSOR-BASED PAGINATION
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

      const edges = data?.data?.products?.edges ?? [];
      edges.forEach((edge) => allProducts.push(edge.node));

      hasNextPage = data?.data?.products?.pageInfo?.hasNextPage || false;
      endCursor = data?.data?.products?.pageInfo?.endCursor || null;
    }

    // ================================================
    // 3) POST-PROCESS PRODUCTS: DETERMINE MASTERS & CHILDREN
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
    // 4) FETCH CHILD VARIANTS (IF ANY)
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
    // 5) ATTACH CHILD VARIANTS TO THEIR MASTERS
    // ================================================
    const productsWithChildren = productsParsed.map((product) => {
      const newEdges = product.variants.edges.map((edge) => {
        const variant = edge.node;
        const resolvedChildren = variant.childVariantIds
          .map((id) => childVariantMap[id])
          .filter(Boolean);
        return { node: { ...variant, childVariants: resolvedChildren } };
      });
      return { ...product, variants: { edges: newEdges } };
    });

    // ======================================================
    // 6) FILTER PRODUCTS TO ONLY INCLUDE ONES WITH A MASTER
    // ======================================================
    /* 
      In this final step, we only keep products that contain 
      at least one variant whose `isMaster` property is true.
    */
    const finalProducts = productsWithChildren.filter((product) =>
      product.variants.edges.some((edge) => edge.node.isMaster)
    );

    // Return subscription info + product data
    return json({
      products: finalProducts,
      locked,
      reason,
      plan: shopSub.plan,
      variantsLimit: shopSub.variantsLimit,
    });
  } catch (error) {
    console.error("Loader error:", error);
    return json(
      {
        products: [],
        locked,
        reason: `Error fetching products: ${error.message}`,
        plan: shopSub.plan,
        variantsLimit: shopSub.variantsLimit,
      },
      { status: 500 }
    );
  }
};

/**
 * ProductsTable Component:
 * Australian English Explanation:
 * This component renders the Master Products page, showing only products
 * that have at least one Master variant. If there's no active subscription,
 * the UI is locked with a banner. Otherwise, we show:
 *
 * - A search bar for filtering products by title.
 * - A table with each product as a parent row, and each variant as a child row.
 * - Master variants can be expanded to see child variants.
 * - Inventory editing and children assignment can be managed via modals.
 */
export default function ProductsTable() {
  if (typeof window === "undefined") return null;

  // Loader data includes products plus subscription lock info
  const {
    products: initialProducts,
    locked,
    reason,
    plan,
    variantsLimit,
  } = useLoaderData();
  const revalidator = useRevalidator();

  // Inline style injection to highlight active Master rows or black toasts
  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
      .activeRow {
        background-color: rgb(173, 173, 173) !important;
      }
      .black-toast .Polaris-Toast {
        background-color: black !important;
        color: white !important;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // If locked => simply show a banner and a blurred table
  // or skip table altogether
  if (locked) {
    return (
      <Frame>
        <Page>
          <Helmet>
            <script src="https://cdn.botpress.cloud/webchat/v2.3/inject.js"></script>
            <script src="https://files.bpcontent.cloud/2025/02/24/22/20250224223007-YAA5E131.js"></script>
          </Helmet>
          <TitleBar title="Master Products" />
          <Banner status="critical" title="Subscription Inactive">
            <p>{reason}</p>
            <Button onClick={() => (window.location.href = "/app/settings")}>
              Choose a plan
            </Button>
          </Banner>
          <Card>
            <div style={{ filter: "blur(3px)", textAlign: "center", padding: "3rem" }}>
              <Text as="p" variant="headingMd">
                Master Products are locked until you have an active subscription.
              </Text>
            </div>
          </Card>
        </Page>
      </Frame>
    );
  }

  // Otherwise, we are not locked => proceed with the normal table
  const [products, setProducts] = useState(initialProducts);
  useEffect(() => setProducts(initialProducts), [initialProducts]);

  // Search, sorting, and pagination
  const [query, setQuery] = useState("");
  const [sortValue, setSortValue] = useState("title");
  const [sortDirection, setSortDirection] = useState("ascending");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;

  // Expanded row logic for products
  const [expandedProductIndex, setExpandedProductIndex] = useState(-1);
  const [expandedMasters, setExpandedMasters] = useState([]); // track expanded master variants

  // Modals and selected product/variant
  const [modalActive, setModalActive] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [childrenModalActive, setChildrenModalActive] = useState(false);

  // Inventory, child checkboxes, toast notifications, etc.
  const [inventory, setInventory] = useState({});
  const [allVariants, setAllVariants] = useState([]);
  const [childrenSelection, setChildrenSelection] = useState([]);
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastType, setToastType] = useState("error"); // "error" or "black"
  const [qtyManagementValues, setQtyManagementValues] = useState({});

  // Additional search & pagination states for the children modal
  const [childrenQuery, setChildrenQuery] = useState("");
  const [childrenCurrentPage, setChildrenCurrentPage] = useState(1);
  const childrenItemsPerPage = 5;

  // Flatten all variants for advanced child selection in modals
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

  // Filter, sort, paginate
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
  const totalProducts = sortedProducts.length;
  const paginatedProducts = sortedProducts.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );
  const startIndex = (currentPage - 1) * itemsPerPage + 1;
  const endIndex = Math.min(totalProducts, currentPage * itemsPerPage);

  const handleSort = useCallback((newSortValue, newSortDirection) => {
    setSortValue(newSortValue);
    setSortDirection(newSortDirection);
  }, []);

  // Toggle expansion for a product row
  const toggleExpanded = useCallback(
    (index) => () => setExpandedProductIndex((prev) => (prev === index ? -1 : index)),
    []
  );

  // Toggle expansion for a Master variant row
  const toggleMasterVariant = (variantId) => {
    setExpandedMasters((prev) =>
      prev.includes(variantId)
        ? prev.filter((id) => id !== variantId)
        : [...prev, variantId]
    );
  };

  // Helper: find which Master variant a Child belongs to
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

  // Decide if a variant's Master checkbox should be disabled
  const isVariantAssignedElsewhere = (variant, currentProductId) => {
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== currentProductId;
  };

  // Check if a child variant is assigned to a different Master
  const isChildVariantAssignedElsewhere = (variant) => {
    if (!selectedProduct) return false;
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== selectedProduct.id;
  };

  // Toast notifications
  function showToast(message, type = "error") {
    setToastMessage(message);
    setToastType(type);
    setToastActive(true);
  }
  function onDismissToast() {
    setToastActive(false);
    setToastMessage("");
  }

  // Inventory modal
  function openMasterInventoryModal(product, masterVariant) {
    setSelectedProduct(product);
    setSelectedVariant(masterVariant);
    setInventory({ [masterVariant.id]: masterVariant.inventoryQuantity });
    setModalActive(true);
  }

  // Toggle the children management modal
  function toggleChildrenModal() {
    setChildrenModalActive((prev) => !prev);
  }

  // Open the children modal for a Master variant
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

  // Toggle selection for a child variant in the modal
  function handleToggleChildSelection(variantGid) {
    setChildrenSelection((prev) =>
      prev.includes(variantGid)
        ? prev.filter((id) => id !== variantGid)
        : [...prev, variantGid]
    );
  }

  /**
   * storeVariantOldQty:
   * Australian English Explanation:
   * This function calls a server endpoint ("/api/update-oldqty") to store
   * the "oldQuantity" for a variant in your DB, also updating the 'qtyold'
   * metafield in Shopify. This ensures a proper historical record for your
   * inventory sync logic.
   */
  async function storeVariantOldQty(variantId, currentQuantity) {
    try {
      await fetch("/api/update-oldqty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId,
          newQty: currentQuantity,
        }),
      });
      console.log(
        `Successfully stored OldQty (${currentQuantity}) for variant ${parseVariantId(variantId)}.`
      );
    } catch (err) {
      console.error("Error storing OldQty in DB:", err);
    }
  }

  // Save children selection in the modal
  async function handleSaveChildren() {
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

    await handleAddChildren(selectedVariant.id, childrenSelection);

    // Immediately store OldQty for each newly selected child
    for (const childGid of childrenSelection) {
      const foundVariant = allVariants.find((av) => av.id === childGid);
      if (foundVariant) {
        const childInventory = foundVariant.inventoryQuantity ?? 0;
        await storeVariantOldQty(childGid, childInventory);
      }
    }

    toggleChildrenModal();
  }

  /**
   * updateMasterMetafield:
   * Calls your /api/update-variant-metafield route to set the "master" metafield
   * to "true" or "false". This toggles a variant as a Master.
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
      if (!response.ok) throw new Error("Failed to update the 'master' metafield");
    } catch (error) {
      console.error("Error updating 'master' metafield:", error);
      throw error;
    }
  }

  /**
   * handleMasterCheckboxChange:
   * When the merchant checks or unchecks the "Master" checkbox on a variant.
   * 1) Immediately updates local state for a responsive UI change.
   * 2) Makes a server call to actually update the metafield in Shopify.
   * 3) If set to true, also stores OldQty to keep track of the new Master variant's inventory.
   */
  async function handleMasterCheckboxChange(productId, variantId, newChecked) {
    if (newChecked) {
      const foundMaster = findMasterOfVariant(variantId);
      if (foundMaster) {
        showToast(`Cannot set as master. This variant is already a child of '${foundMaster.masterProductTitle}'.`);
        return;
      }
    }
    // Update local state
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

    // Server call to update the metafield
    try {
      await updateMasterMetafield(variantId, newChecked);

      // If newly set to Master, store the current inventory as OldQty
      if (newChecked) {
        const productInState = products.find((p) => p.id === productId);
        if (productInState) {
          const variant = productInState.variants.edges.find((ed) => ed.node.id === variantId)?.node;
          if (variant) {
            const currentInventory = variant.inventoryQuantity ?? 0;
            await storeVariantOldQty(variantId, currentInventory);
          }
        }
      }
    } catch (error) {
      console.error("Failed to update master metafield on server:", error);
      // Revert the checkbox on error
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
   * Updates the "childrenkey" metafield on a Master variant in Shopify,
   * storing the new array of child variant GIDs.
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
      if (!response.ok) throw new Error("Failed to update childrenkey");
      // Update local state to reflect the new child assignments
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

  /**
   * handleInventoryChange:
   * Adjust the local state of 'inventory' for the chosen Master variant
   * before sending it to the server.
   */
  function handleInventoryChange(variantId, newQuantity) {
    setInventory((prev) => ({ ...prev, [variantId]: newQuantity }));
  }

  /**
   * updateInventory:
   * Calls a server endpoint ("/api/update-inventory") to adjust the stock
   * of the Master variant, optionally also affecting children if the route
   * is written that way.
   */
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

      // Update local state
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

  /**
   * updateQtyManagement:
   * This function updates the "qtymanagement" metafield for a child variant,
   * used to determine the ratio of how many items should be deducted from the Master.
   */
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
      showToast(`Master Ratio updated for variant ${parseVariantId(variantId)}`, "black");
    } catch (error) {
      console.error("Error updating qty management metafield:", error);
      showToast(`Error updating Master Ratio for variant ${parseVariantId(variantId)}`);
    }
  }

  /**
   * getVariantStatus:
   * Returns an object describing whether the variant is a Master, Child, or Unassigned,
   * and includes a background colour for row highlighting.
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

    let bgColour = "#ffffff"; // default
    if (status === "Master") {
      bgColour = "#333333";
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
        <Helmet>
          <script src="https://cdn.botpress.cloud/webchat/v2.3/inject.js"></script>
          <script src="https://files.bpcontent.cloud/2025/02/24/22/20250224223007-YAA5E131.js"></script>
        </Helmet>

        <TitleBar title="Master Products" />

        {/* This card contains the search bar plus the IndexTable of products */}
        <Card padding="0">
          {/* Search bar */}
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

          {/* IndexTable: each product is a parent row, each variant is a child row */}
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

              // Parent row representing the product
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
                      <div
                        style={{
                          display: "inline-block",
                          maxWidth: "fit-content",
                          whiteSpace: "nowrap",
                        }}
                      >
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

              // Child rows representing each variant
              let variantSubRows = null;
              if (isProductExpanded) {
                variantSubRows = product.variants.edges.map((variantEdge, variantIndex) => {
                  const variant = variantEdge.node;
                  const { status, bgColour } = getVariantStatus(variant);
                  const shortVariantId = parseVariantId(variant.id);

                  // Single variant row
                  const variantRow = (
                    <IndexTable.Row
                      rowType="child"
                      id={`variant-${variant.id}`}
                      key={variant.id}
                      position={productIndex + 1 + variantIndex}
                      onClick={(e) => {
                        // Prevent row-click from toggling product expansion
                        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
                        if (variant.isMaster) toggleMasterVariant(variant.id);
                      }}
                      className={
                        variant.isMaster && expandedMasters.includes(variant.id) ? "activeRow" : ""
                      }
                      style={{ backgroundColor: bgColour }}
                    >
                      <IndexTable.Cell>
                        <Thumbnail
                          source={
                            variant.image?.originalSrc ||
                            product.images.edges[0]?.node.originalSrc ||
                            ""
                          }
                          size="small"
                          alt={variant.title}
                        />
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                          {variant.isMaster ? (
                            <div
                              style={{
                                display: "inline-block",
                                maxWidth: "fit-content",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <Tag status="success">
                                Variant Master – {shortVariantId}
                              </Tag>
                            </div>
                          ) : (
                            <div
                              style={{
                                display: "inline-block",
                                maxWidth: "fit-content",
                                whiteSpace: "nowrap",
                              }}
                            >
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
                          disabled={
                            !variant.isMaster && isVariantAssignedElsewhere(variant, product.id)
                          }
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

                  // If expanded and is Master => show nested child rows
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
                                <div
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "0.25rem",
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "inline-block",
                                      maxWidth: "fit-content",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
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
                              <IndexTable.Cell />
                              <IndexTable.Cell>
                                {/* Master Ratio editor */}
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
                                    Master Ratio
                                  </Text>
                                  <TextField
                                    label=""
                                    placeholder="1 by default"
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

          {/* Table pagination */}
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
              <div
                style={{
                  display: "inline-block",
                  maxWidth: "fit-content",
                  whiteSpace: "nowrap",
                }}
              >
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
                Please select which variants should be assigned as children for this master variant.
                Current selections are pre-checked.
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
                          <div
                            style={{
                              display: "inline-block",
                              maxWidth: "fit-content",
                              whiteSpace: "nowrap",
                            }}
                          >
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
        <div className={toastType === "black" ? "black-toast" : ""}>
          <Toast
            content={toastMessage}
            onDismiss={() => setToastActive(false)}
            error={toastType === "error"} 
          />
        </div>
      )}
    </Frame>
  );
}
