// app/routes/app.products.jsx
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
  Tooltip,
  Banner,
} from "@shopify/polaris";
import { SearchIcon, XCircleIcon } from "@shopify/polaris-icons";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { TitleBar } from "@shopify/app-bridge-react";
import { Helmet } from "react-helmet";

/**
 * parseVariantId:
 * Extracts the numeric part from a Shopify GID string.
 * E.g., "gid://shopify/ProductVariant/12345" returns "12345".
 */
function parseVariantId(gid = "") {
  return gid.split("/").pop();
}

/**
 * loader:
 * 1) Authenticates the admin user.
 * 2) Retrieves the active subscription plan from your Prisma DB to enforce any usage limits.
 * 3) Fetches all products, plus their variants & relevant metafields from Shopify via GraphQL.
 * 4) Gathers child variants for each Master variant, attaching them in the final data.
 * 5) Counts how many total variants are designated as Master or Child, compares with the plan limit.
 * 6) Returns 'locked' = true if no active plan is found, or 'overLimit' = true if usage is exceeded.
 */
export const loader = async ({ request }) => {
  console.log("Loader start: Authenticating and retrieving products…");
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session?.shop;

  if (!shopDomain) {
    return json({ error: "No shop found in session" }, { status: 401 });
  }

  // Fetch subscription info from your database
  let shopSub = await prisma.shopSubscription.findUnique({
    where: { shop: shopDomain },
  });

  // If not found, or not ACTIVE, lock the interface
  let locked = false;
  let plan = "NONE";
  let variantsLimit = 0;
  let status = "INACTIVE";

  if (!shopSub || shopSub.status !== "ACTIVE") {
    locked = true;
  } else {
    plan = shopSub.plan || "UNKNOWN";
    variantsLimit = shopSub.variantsLimit ?? 0;
    status = shopSub.status;
  }

  // 1) Fetch all products using cursor-based pagination
  let allProducts = [];
  let hasNextPage = true;
  let endCursor = null;
  const pageSize = 100;

  try {
    while (hasNextPage) {
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
  } catch (error) {
    console.error("Loader error when fetching products:", error);
    return json({ products: [], error: error.message, locked, plan, variantsLimit }, { status: 500 });
  }

  // 2) Mark Master variants + parse their children
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
        } catch (err) {
          console.error("Error parsing children for variant", variant.id, err);
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

  // 3) Fetch child variants (if any)
  const uniqueChildIds = [...new Set(allChildVariantIds)];
  let childVariantMap = {};
  if (uniqueChildIds.length > 0) {
    try {
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
    } catch (error) {
      console.error("Loader error when fetching child variants:", error);
    }
  }

  // 4) Attach child variants to their Masters
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

  // 5) Count how many are Master or Child to see if we exceed the plan limit
  let totalSyncedVariants = 0;
  finalProducts.forEach((p) => {
    p.variants.edges.forEach((ve) => {
      const v = ve.node;
      // If it's Master or if it belongs to any Master as a child, increment
      const isChild = v.childVariantIds?.length === 0
        ? false
        : true; // (Just a quick check; you might refine logic for "belongs as child")
      if (v.isMaster || isChild) {
        totalSyncedVariants += 1;
      }
    });
  });

  let overLimit = false;
  let mustRemove = 0;
  if (!locked) {
    // If we have an active plan, compare with variantsLimit
    if (variantsLimit > 0 && totalSyncedVariants > variantsLimit) {
      overLimit = true;
      mustRemove = totalSyncedVariants - variantsLimit;
    }
  }

  return json({
    products: finalProducts,
    locked,
    plan,
    status,
    variantsLimit,
    totalSyncedVariants,
    overLimit,
    mustRemove,
  });
};

/**
 * ProductsTable Component (default export):
 * Renders the main Products page with subscription plan enforcement.
 *
 * If locked=true (no active plan), we blur the table and show a lock banner.
 * If overLimit=true, we show a warning banner asking the merchant to remove some Masters/Children
 * or upgrade their plan. We still render the table, but can disable certain actions if needed.
 *
 * The rest of the code manages searching, pagination, expansion of product rows, master checkboxes,
 * child assignment modals, and quantity management fields.
 */
export default function ProductsTable() {
  if (typeof window === "undefined") return null;

  const {
    products: initialProducts,
    locked,
    plan,
    status,
    variantsLimit,
    totalSyncedVariants,
    overLimit,
    mustRemove,
  } = useLoaderData();

  const revalidator = useRevalidator();

  // Add custom CSS to force active background color on "activeRow"
  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
      .activeRow {
        background-color: rgb(173, 173, 173) !important;
      }
      .blurredTable {
        filter: blur(3px);
        pointer-events: none;
        opacity: 0.6;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Local state for displayed products
  const [products, setProducts] = useState(initialProducts);
  useEffect(() => setProducts(initialProducts), [initialProducts]);

  // Search, sort, pagination states
  const [query, setQuery] = useState("");
  const [sortValue, setSortValue] = useState("title");
  const [sortDirection, setSortDirection] = useState("ascending");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;

  // Row expansion states
  const [expandedProductIndex, setExpandedProductIndex] = useState(-1);
  const [expandedMasters, setExpandedMasters] = useState([]);

  // State for modals
  const [modalActive, setModalActive] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [childrenModalActive, setChildrenModalActive] = useState(false);

  // Inventory, child selection, and toast
  const [inventory, setInventory] = useState({});
  const [allVariants, setAllVariants] = useState([]);
  const [childrenSelection, setChildrenSelection] = useState([]);
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [qtyManagementValues, setQtyManagementValues] = useState({});

  // Children modal pagination
  const [childrenQuery, setChildrenQuery] = useState("");
  const [childrenCurrentPage, setChildrenCurrentPage] = useState(1);
  const childrenItemsPerPage = 5;

  // Compute filtered / sorted / paginated
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
  const startIndex = (currentPage - 1) * itemsPerPage + 1;
  const endIndex = Math.min(totalProducts, currentPage * itemsPerPage);

  const paginatedProducts = sortedProducts.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Build a flattened list of all variants (used in child assignment modals, etc.)
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

  /** onSort callback for the IndexTable headings */
  const handleSort = useCallback((newSortValue, newSortDirection) => {
    setSortValue(newSortValue);
    setSortDirection(newSortDirection);
  }, []);

  /** Toggles expansion for the entire product row (parent) */
  const toggleExpanded = useCallback(
    (index) => () => setExpandedProductIndex((prev) => (prev === index ? -1 : index)),
    []
  );

  /** Toggles expansion for a Master variant to display its child variants */
  const toggleMasterVariant = (variantId) => {
    setExpandedMasters((prev) =>
      prev.includes(variantId) ? prev.filter((id) => id !== variantId) : [...prev, variantId]
    );
  };

  /** Finds which Master variant (if any) references this child variant */
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

  /** Disables the 'Master' checkbox if variant is already assigned as a child in another product */
  const isVariantAssignedElsewhere = (variant, currentProductId) => {
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== currentProductId;
  };

  /** Disables child selection if the variant is already a child of another Master */
  const isChildVariantAssignedElsewhere = (variant) => {
    if (!selectedProduct) return false;
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== selectedProduct.id;
  };

  /** Simple toast handlers */
  function showToast(message) {
    setToastMessage(message);
    setToastActive(true);
  }
  function onDismissToast() {
    setToastActive(false);
    setToastMessage("");
  }

  /** Opens the modal for editing inventory on a given Master variant */
  function openMasterInventoryModal(product, masterVariant) {
    setSelectedProduct(product);
    setSelectedVariant(masterVariant);
    setInventory({ [masterVariant.id]: masterVariant.inventoryQuantity });
    setModalActive(true);
  }

  /** Toggles the children assignment modal */
  function toggleChildrenModal() {
    setChildrenModalActive((prev) => !prev);
  }

  /** Opens the children assignment modal for a Master variant */
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

  /** Toggles selection for a child variant in the children modal */
  function handleToggleChildSelection(variantGid) {
    setChildrenSelection((prev) =>
      prev.includes(variantGid) ? prev.filter((id) => id !== variantGid) : [...prev, variantGid]
    );
  }

  /**
   * storeVariantOldQty:
   * Calls a backend route to store the 'oldQuantity' in your DB. This mimics your webhook approach.
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

  /** handleSaveChildren: Updates the children list in the 'childrenkey' metafield, and stores OldQty. */
  async function handleSaveChildren() {
    if (!selectedVariant) return;

    // Validate that none of the chosen children are Master or already assigned
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

    // 1) Update children array
    await handleAddChildren(selectedVariant.id, childrenSelection);

    // 2) For each newly selected child, store OldQty
    for (const childGid of childrenSelection) {
      const foundVariant = allVariants.find((av) => av.id === childGid);
      if (foundVariant) {
        const childInventory = foundVariant.inventoryQuantity ?? 0;
        await storeVariantOldQty(childGid, childInventory);
      }
    }

    toggleChildrenModal();
  }

  /** Updates the 'master' metafield in Shopify for a variant, setting isMaster = true/false. */
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
   * 1) Checks if variant is already a child elsewhere if enabling Master.
   * 2) Immediately updates local state for quick UI reflection.
   * 3) Calls updateMasterMetafield to store in Shopify.
   * 4) If becoming Master, also store its current inventory as OldQty.
   * 5) Reverts local state if server call fails.
   */
  async function handleMasterCheckboxChange(productId, variantId, newChecked) {
    if (newChecked) {
      const foundMaster = findMasterOfVariant(variantId);
      if (foundMaster) {
        showToast(`Cannot set as master. This variant is already a child of '${foundMaster.masterProductTitle}'.`);
        return;
      }
    }
    // Update local UI
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
      // Update on Shopify
      await updateMasterMetafield(variantId, newChecked);

      // If newly checked => store OldQty
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
      // Revert local state if server call failed
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

  /** handleAddChildren: updates the 'childrenkey' metafield with the new array of children. */
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
      // Locally update
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

  /** handleInventoryChange: local state setter for inventory quantity in the modal. */
  function handleInventoryChange(variantId, newQuantity) {
    setInventory((prev) => ({ ...prev, [variantId]: newQuantity }));
  }

  /**
   * updateInventory:
   * Sends the updated quantity to your backend route "/api/update-inventory"
   * which presumably calls Shopify's GraphQL to set a new inventory level for the master variant.
   * Then it updates local state to reflect the new quantity.
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
   * Sets the 'qtymanagement' metafield to define the child's ratio with respect to the master's inventory.
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
      showToast(`Master Ratio updated for variant ${parseVariantId(variantId)}`);
    } catch (error) {
      console.error("Error updating qty management metafield:", error);
      showToast(`Error updating Master Ratio for variant ${parseVariantId(variantId)}`);
    }
  }

  /**
   * getVariantStatus:
   * Identifies if a variant is Master, Child, or Unassigned, returning a label and background colour.
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

    let bgColour = "#ffffff";
    if (status === "Master") {
      bgColour = "#333333"; // default master color
      if (expandedMasters.includes(variant.id)) {
        bgColour = "#cceeff"; // highlight if expanded
      }
    } else if (status === "Child") {
      bgColour = "#fff4e5"; // pale orange for child
    }
    return { status, bgColour };
  }

  /** Over-limit banner (if user exceeds variant usage) */
  let limitBanner = null;
  if (overLimit) {
    limitBanner = (
      <Banner status="critical" title="Variant Limit Exceeded">
        <p>
          You have {totalSyncedVariants} synced variants, but your plan allows only {variantsLimit}.<br />
          Please remove at least {mustRemove} Master/Child assignments or upgrade your plan
          to restore full functionality.
        </p>
      </Banner>
    );
  }

  /** If locked => we blur the entire table and show a banner. */
  const tableClassName = locked ? "blurredTable" : "";

  return (
    <Frame>
      <Page>
        <Helmet>
          <script src="https://cdn.botpress.cloud/webchat/v2.3/inject.js"></script>
          <script src="https://files.bpcontent.cloud/2025/02/24/22/20250224223007-YAA5E131.js"></script>
        </Helmet>
        <TitleBar title="All your products" />
        
        {/* If locked => show a banner indicating no active subscription */}
        {locked && (
          <Banner status="critical" title="No Active Subscription">
            <p>
              Your current plan status is <strong>{status}</strong>. You do not have an active
              subscription. Please choose or upgrade a plan to unlock Synclogic.
            </p>
            <Button url="/app/settings" primary>
              Choose a Plan
            </Button>
          </Banner>
        )}

        {/* If over-limit => show a banner asking user to remove or upgrade */}
        {limitBanner}

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

          {/* Table of products */}
          <div className={tableClassName}>
            <IndexTable
              headings={[
                { title: "Product" },
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

                // If expanded => show variant sub-rows
                let variantSubRows = null;
                if (isProductExpanded) {
                  variantSubRows = product.variants.edges.map((variantEdge, variantIndex) => {
                    const variant = variantEdge.node;
                    const { status, bgColour } = getVariantStatus(variant);
                    const shortVariantId = parseVariantId(variant.id);

                    // Master or standard variant row
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
                          <Tooltip content="Set this variant as a Master variant.">
                            <Checkbox
                              data-polaris-tooltip-activator="true"
                              checked={variant.isMaster}
                              disabled={
                                locked ||
                                (!variant.isMaster && isVariantAssignedElsewhere(variant, product.id))
                              }
                              onChange={(checked) =>
                                handleMasterCheckboxChange(product.id, variant.id, checked)
                              }
                            />
                          </Tooltip>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <div style={{ display: "flex", gap: "0.5rem" }}>
                            <Button
                              primary
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!locked && !overLimit) {
                                  openChildrenModal(product, variant);
                                }
                              }}
                              disabled={locked || overLimit}
                            >
                              Manage Children
                            </Button>
                            <Button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!locked && !overLimit) {
                                  openMasterInventoryModal(product, variant);
                                }
                              }}
                              disabled={locked || overLimit}
                            >
                              Edit Inventory
                            </Button>
                          </div>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    );

                    // Nested child rows if Master is expanded
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
                                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                                    <Tooltip content="Set the Master Ratio for this child variant.">
                                      <Text
                                        as="span"
                                        variant="bodySm"
                                        fontWeight="bold"
                                        style={{ marginBottom: "0.5rem" }}
                                        data-polaris-tooltip-activator="true"
                                      >
                                        Master Ratio
                                      </Text>
                                    </Tooltip>
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
                                      disabled={locked || overLimit}
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
          </div>

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
                Current selections are pre-checked. Some variants may be disabled if already assigned.
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
                          disabled={disabledCheckbox || locked || overLimit}
                          onChange={() => handleToggleChildSelection(item.id)}
                        />
                        <div style={{ marginLeft: "1rem" }}>
                          <div
                            style={{ display: "inline-block", maxWidth: "fit-content", whiteSpace: "nowrap" }}
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

      {toastActive && <Toast content={toastMessage} onDismiss={onDismissToast} error />}
    </Frame>
  );
}
