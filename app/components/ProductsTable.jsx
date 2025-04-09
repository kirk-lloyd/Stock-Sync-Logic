import React, { useState, useCallback, useEffect } from "react";
import {
  Box,
  Card,
  IndexTable,
  Thumbnail,
  Button,
  TextField,
  Tag,
  Frame,
  Toast,
  Text,
  Pagination,
  Icon,
  Banner
} from "@shopify/polaris";
import { SearchIcon, XCircleIcon } from "@shopify/polaris-icons";
import SyncVariantModal from "./SyncVariantModal";

/**
 * ProductsTable Component
 * A reusable table component for displaying product and variant data
 * 
 * @param {Object} props Component props
 * @param {Array} props.initialProducts Initial products array from the loader
 * @param {Boolean} props.locked Whether the user's subscription is locked
 * @param {Boolean} props.showMasterVariantsOnly Filter to only show master variants
 */
export function ProductsTable({ initialProducts, locked, showMasterVariantsOnly = false }) {
  // State management for product data
  const [products, setProducts] = useState(initialProducts);
  useEffect(() => setProducts(initialProducts), [initialProducts]);
  
  // Track expanded states for UI
  const [expandedMasters, setExpandedMasters] = useState([]);
  const [expandedProductIndex, setExpandedProductIndex] = useState(-1);
  
  // Estado para controlar si estamos en el cliente (para evitar problemas de hidratación)
  const [isClient, setIsClient] = useState(false);
  
  // Marca que estamos en el cliente después del primer render
  useEffect(() => {
    setIsClient(true);
  }, []);
  
  // Automatically expand master variants on load (solo en el cliente)
  useEffect(() => {
    if (!isClient) return;
    
    const mastersWithChildren = [];
    products.forEach((prod) => {
      if (prod.variants && prod.variants.edges) {
        prod.variants.edges.forEach((ve) => {
          const variant = ve.node;
          if (variant.isMaster && variant.childVariantIds && variant.childVariantIds.length > 0) {
            mastersWithChildren.push(variant.id);
          }
        });
      }
    });
    setExpandedMasters(mastersWithChildren);
  }, [products, isClient]);

  // UI state management
  const [query, setQuery] = useState("");
  const [sortValue, setSortValue] = useState("title");
  const [sortDirection, setSortDirection] = useState("ascending");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;
  
  // Toast notification state
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  
  // Track all variants for search and filtering
  const [allVariants, setAllVariants] = useState([]);
  
  // State for controlling the Sync Variant Modal
  const [syncVariantId, setSyncVariantId] = useState(null);

  // Collect all variants for search functionality
  useEffect(() => {
    if (!isClient) return;
    
    const variantsList = [];
    products.forEach((prod) => {
      if (prod.variants && prod.variants.edges) {
        prod.variants.edges.forEach((ve) => {
          variantsList.push({
            ...ve.node,
            productTitle: prod.title,
            productImage: prod.images?.edges?.[0]?.node?.originalSrc || "",
          });
        });
      }
    });
    setAllVariants(variantsList);
  }, [products, isClient]);

  // Function to open the sync modal for a given variant with subscription check
  function openSyncModal(variantId) {
    if (locked) {
      showToast("Please activate your subscription to perform this action.");
      return;
    }
    setSyncVariantId(variantId);
  }

  // Handle sorting logic
  const handleSort = useCallback((newSortValue, newSortDirection) => {
    setSortValue(newSortValue);
    setSortDirection(newSortDirection);
  }, []);

  // Toggle product expansion
  const toggleExpanded = useCallback(
    (index) => () => setExpandedProductIndex((prev) => (prev === index ? -1 : index)),
    []
  );
  
  // Toggle master variant expansion
  const toggleMasterVariant = (variantId) => {
    setExpandedMasters((prev) =>
      prev.includes(variantId) ? prev.filter((id) => id !== variantId) : [...prev, variantId]
    );
  };

  // Find the master variant of a specific variant
  function findMasterOfVariant(variantId) {
    for (const prod of products) {
      if (prod.variants && prod.variants.edges) {
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
    }
    return null;
  }

  // Check if a variant is assigned elsewhere
  const isVariantAssignedElsewhere = (variant, currentProductId) => {
    const found = findMasterOfVariant(variant.id);
    return found && found.masterProductId !== currentProductId;
  };

  // Toast notification functionality
  function showToast(message) {
    setToastMessage(message);
    setToastActive(true);
  }
  
  function onDismissToast() {
    setToastActive(false);
    setToastMessage("");
  }

  // Extract a short variant ID for display
  function parseVariantId(gid = "") {
    return gid.split("/").pop();
  }
  
  // Custom thumbnail component con soporte SSR
  function CustomThumbnail({ source, alt, size = "medium" }) {
    const [imageLoaded, setImageLoaded] = useState(false);
    const [hasError, setHasError] = useState(false);
    
    // Dimensiones basadas en el parámetro de tamaño
    const sizeStyles = {
      small: { width: "40px", height: "40px", fontSize: "10px" },
      medium: { width: "60px", height: "60px", fontSize: "12px" },
      large: { width: "80px", height: "80px", fontSize: "14px" }
    };
    
    // Estilo base para placeholder
    const style = {
      ...(sizeStyles[size] || sizeStyles.medium),
      backgroundColor: "#e4e5e7",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "3px",
      color: "#5c5f62",
      fontWeight: "500"
    };
    
    // Efectos para cargar la imagen
    useEffect(() => {
      if (!source) return;
      
      const img = new Image();
      img.src = source;
      
      img.onload = () => {
        setImageLoaded(true);
        setHasError(false);
      };
      
      img.onerror = () => {
        setHasError(true);
      };
      
      return () => {
        img.onload = null;
        img.onerror = null;
      };
    }, [source]);
    
    // Si no hay source o hay error, mostrar placeholder
    if (!source || hasError) {
      return (
        <div style={style}>
          <span>{alt ? alt.charAt(0).toUpperCase() : 'N'}</span>
        </div>
      );
    }
    
    // Si estamos en cliente y la imagen cargó exitosamente
    if (isClient && imageLoaded) {
      return <Thumbnail source={source} alt={alt || ""} size={size} />;
    }
    
    // Placeholder mientras carga o para SSR
    return (
      <div style={style}>
        <span>{alt ? alt.charAt(0).toUpperCase() : 'N'}</span>
      </div>
    );
  }

  // Get status information for a variant
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
      bgColour = "#333333";
      if (expandedMasters.includes(variant.id)) bgColour = "#cceeff";
    } else if (status === "Child") {
      bgColour = "#fff4e5";
    }
    return { status, bgColour };
  }

  // Table styling for locked state
  const tableClassName = locked ? "blurredTable" : "";

  // Apply filtering based on query
  const filteredProducts = products.filter((product) =>
    (product.title ?? "").toLowerCase().includes(query.toLowerCase())
  );
  
  // Apply master-only filtering if enabled
  const filteredByMaster = showMasterVariantsOnly
    ? filteredProducts.filter(product => 
        product.variants?.edges?.some(edge => edge.node.isMaster))
    : filteredProducts;
  
  // Sort the filtered products
  const sortedProducts = [...filteredByMaster].sort((a, b) => {
    if (sortValue === "title") {
      const titleA = (a.title ?? "").toLowerCase();
      const titleB = (b.title ?? "").toLowerCase();
      const result = titleA.localeCompare(titleB);
      return sortDirection === "ascending" ? result : -result;
    }
    return 0;
  });

  // Pagination calculations
  const totalProducts = sortedProducts.length;
  const startIndex = (currentPage - 1) * itemsPerPage + 1;
  const endIndex = Math.min(totalProducts, currentPage * itemsPerPage);
  const paginatedProducts = sortedProducts.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Add custom CSS for row styling - Solo en cliente
  useEffect(() => {
    if (!isClient) return;
    
    const style = document.createElement("style");
    style.innerHTML = `
      .activeRow { background-color: rgb(173, 173, 173) !important; }
      .blurredTable { filter: blur(3px); pointer-events: none; opacity: 0.6; }
    `;
    document.head.appendChild(style);
    return () => {
      if (document.head.contains(style)) {
        document.head.removeChild(style);
      }
    };
  }, [isClient]);

  return (
    <>
      {locked && isClient && (
        <Banner
          status="critical"
          title="No Active Subscription"
          action={{ content: 'Activate Subscription', url: '/app/settings' }}
        >
          <p>Your subscription is not active. Please activate your subscription to use all features.</p>
        </Banner>
      )}
      
      <Card padding="0">
        <Box paddingBlock="300" paddingInline="300" style={{ marginBottom: "10px" }}>
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
              { title: "Actions" },
            ]}
            itemCount={paginatedProducts.length}
            selectable={false}
          >
            {paginatedProducts.map((product, productIndex) => {
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
                    <CustomThumbnail
                      source={product.images?.edges?.[0]?.node?.originalSrc}
                      alt={product.title || "No Title"}
                    />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                      <div style={{ whiteSpace: "nowrap" }}>
                        <Tag>{product.variants?.edges?.length || 0} variants</Tag>
                      </div>
                      <Text as="span" variant="headingMd" fontWeight="semibold">
                        {product.title || "Untitled Product"}
                      </Text>
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell />
                  <IndexTable.Cell />
                </IndexTable.Row>
              );
              
              // Render variant rows when product is expanded
              let variantSubRows = null;
              if (isProductExpanded) {
                // Filter variants based on the master-only flag if needed
                const variantsToShow = showMasterVariantsOnly
                  ? product.variants.edges.filter(edge => edge.node.isMaster)
                  : product.variants.edges;
                
                variantSubRows = variantsToShow.map((variantEdge, variantIndex) => {
                  const variant = variantEdge.node;
                  const { status, bgColour } = getVariantStatus(variant);
                  const shortVariantId = parseVariantId(variant.id);
                  const variantRow = (
                    <IndexTable.Row
                      rowType="child"
                      id={`variant-${variant.id}`}
                      key={variant.id}
                      position={productIndex + 1 + variantIndex}
                      onClick={(e) => {
                        if (e.stopPropagation) e.stopPropagation();
                        if (variant.isMaster) toggleMasterVariant(variant.id);
                      }}
                      className={variant.isMaster && expandedMasters.includes(variant.id) ? "activeRow" : ""}
                      style={{ backgroundColor: bgColour }}
                    >
                      <IndexTable.Cell>
                        <CustomThumbnail
                          source={variant.image?.originalSrc || product.images?.edges?.[0]?.node?.originalSrc}
                          size="small"
                          alt={variant.title || "No Title"}
                        />
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                          {variant.isMaster ? (
                            <div style={{ whiteSpace: "nowrap" }}>
                              <Tag status="success">Variant Master – {shortVariantId}</Tag>
                            </div>
                          ) : (
                            <div style={{ whiteSpace: "nowrap" }}>
                              <Tag status={status === "Child" ? "warning" : "default"}>
                                Variant – {shortVariantId}
                              </Tag>
                            </div>
                          )}
                          <Text as="span" variant="headingSm">
                            {variant.title || ""}
                          </Text>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {variant.isMaster ? (
                          <Tag status="success" size="small">Master</Tag>
                        ) : findMasterOfVariant(variant.id) ? (
                          <Tag status="warning" size="small">Child</Tag>
                        ) : (
                          <Tag size="small">Unassigned</Tag>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <Button
                            primary
                            onClick={(e) => {
                              e.stopPropagation();
                              openSyncModal(variant.id);
                            }}
                            disabled={locked}
                          >
                            {locked ? "Subscription Required" : "Sync Variant"}
                          </Button>
                        </div>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                  
                  // Render child variants if master is expanded
                  const childVariantRows =
                    variant.isMaster &&
                    variant.childVariants?.length > 0 &&
                    expandedMasters.includes(variant.id)
                      ? variant.childVariants.map((childVar, childIndex) => {
                          const shortChildId = parseVariantId(childVar.id);
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
                                <CustomThumbnail
                                  source={childVar.image?.originalSrc}
                                  size="small"
                                  alt={childVar.title || ""}
                                />
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                                  <Tag status="warning">Variant – {shortChildId}</Tag>
                                  <Text as="span" variant="headingSm">
                                    {childVar.title || ""}
                                  </Text>
                                </div>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Tag status="warning" size="small">Child</Tag>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                {/* No actions for child variants */}
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
        <Pagination
          onPrevious={() => setCurrentPage((prev) => prev - 1)}
          onNext={() => setCurrentPage((prev) => prev + 1)}
          type="table"
          hasPrevious={currentPage > 1}
          hasNext={currentPage < Math.ceil(totalProducts / itemsPerPage)}
          label={`${startIndex}-${endIndex} of ${totalProducts} products`}
        />
      </Card>
      
      {/* Toast notification - solo en cliente */}
      {isClient && toastActive && (
        <Toast content={toastMessage} onDismiss={onDismissToast} />
      )}
      
      {/* Sync Variant Modal - solo en cliente */}
      {isClient && syncVariantId && (
        <SyncVariantModal
          variantId={syncVariantId}
          locked={locked}
          onClose={() => setSyncVariantId(null)}
          onUpdate={(updatedVariant) => {
            setProducts((prev) =>
              prev.map((prod) => {
                if (!prod.variants) return prod;
                const updatedEdges = prod.variants.edges.map((edge) =>
                  edge.node.id === updatedVariant.id ? { node: updatedVariant } : edge
                );
                return { ...prod, variants: { edges: updatedEdges } };
              })
            );
          }}
        />
      )}
    </>
  );
}

/**
 * Utility function to parse variant IDs from Shopify GID
 * @param {string} gid - The Shopify GID string
 * @returns {string} The extracted numeric ID
 */
export function parseVariantId(gid = "") {
  return gid.split("/").pop();
}

/**
 * Utility function to show a toast notification
 * This can be imported and used in other components
 */
export function useToast() {
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("");
  
  const showToast = (msg) => {
    setMessage(msg);
    setActive(true);
  };
  
  const dismissToast = () => {
    setActive(false);
    setMessage("");
  };
  
  return {
    active,
    message,
    showToast,
    dismissToast
  };
}