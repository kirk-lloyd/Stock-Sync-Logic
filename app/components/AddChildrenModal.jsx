import React, { useState, useEffect } from "react";
import {
  Modal,
  TextField,
  TextContainer,
  Tag,
  Spinner,
  Button,
  EmptyState,
  Card,
  Grid,
  Text,
  Pagination,
  Banner,
  Link
} from "@shopify/polaris";

/**
 * AddChildrenModal Component
 * 
 * A modal interface for selecting and adding child variants to a master variant.
 * Supports dynamic loading of additional variants beyond the standard 250 limit.
 * 
 * @param {boolean} open - Whether the modal is open
 * @param {function} onClose - Callback function to close the modal
 * @param {string} variantId - The ID of the master variant
 * @param {array} currentChildren - Array of current child variant IDs
 * @param {function} onAddChild - Callback function to add a child variant
 * @param {function} setError - Function to set error messages in parent component
 */
export default function AddChildrenModal({ 
  open, 
  onClose, 
  variantId, 
  currentChildren, 
  onAddChild,
  setError
}) {
  // Component for handling variant images with proper fallback
  const VariantImage = ({ src, alt, size = "small" }) => {
    const [hasError, setHasError] = useState(false);
    
    // Dimensions based on size parameter
    const dimensions = {
      small: { width: '40px', height: '40px', fontSize: '9px' },
      medium: { width: '50px', height: '50px', fontSize: '10px' },
      large: { width: '60px', height: '60px', fontSize: '12px' }
    };
    
    // Use default size if an invalid size is provided
    const { width, height, fontSize } = dimensions[size] || dimensions.medium;
    
    // Common styles
    const containerStyle = {
      width,
      height,
      border: '1px solid #ddd',
      borderRadius: '4px',
      overflow: 'hidden'
    };
    
    // Styles for fallback display
    const fallbackStyle = {
      ...containerStyle,
      backgroundColor: '#f0f0f0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    };
    
    // If there's no URL or loading error, show fallback
    if (!src || hasError) {
      return (
        <div style={fallbackStyle}>
          <span style={{ color: '#999', fontSize }}>{alt ? alt.charAt(0) : 'N'}</span>
        </div>
      );
    }
    
    // Otherwise, show the image with error handling
    return (
      <div style={containerStyle}>
        <img 
          src={src}
          alt={alt || 'Product'} 
          style={{ 
            width: '100%',
            height: '100%',
            objectFit: 'contain'
          }} 
          onError={() => setHasError(true)}
        />
      </div>
    );
  };

  // State for search and pagination
  const [childSearchQuery, setChildSearchQuery] = useState("");
  const [availableProducts, setAvailableProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [childrenPage, setChildrenPage] = useState(1);
  const [totalAvailableProducts, setTotalAvailableProducts] = useState(0);
  const childrenPerPage = 10;
  
  // State for pagination information
  const [hasNextPage, setHasNextPage] = useState(false);
  const [hasPreviousPage, setHasPreviousPage] = useState(false);
  
  // State for product cursor
  const [cursor, setCursor] = useState(null);
  
  // State for products with additional variants
  const [productsWithMoreVariants, setProductsWithMoreVariants] = useState([]);
  
  // State for loading additional variants
  const [loadingMoreVariants, setLoadingMoreVariants] = useState(false);
  
  // State for error handling
  const [fetchError, setFetchError] = useState(null);
  
  // Debug logging function
  const logDebug = (message, data) => {
    console.log(`[AddChildrenModal] ${message}`, data || '');
  };

  /**
   * Fetches available products that can be added as children with pagination
   * 
   * @param {number} page - The page number for pagination
   * @param {string} searchQuery - Search query to filter available variants
   * @param {string} currentCursor - Cursor for pagination
   */
  const fetchAvailableProducts = async (page = 1, searchQuery = "", currentCursor = null) => {
    logDebug(`Fetching products for page ${page} with query "${searchQuery}" and cursor:`, currentCursor);
    
    try {
      setLoadingProducts(true);
      setFetchError(null);
      
      // Build the API URL
      const url = new URL(`${window.location.origin}/api/bulk-products`);
      url.searchParams.append('limit', childrenPerPage);
      
      // Add cursor if it exists
      if (currentCursor) {
        url.searchParams.append('cursor', currentCursor);
      }
      
      // Add search query if it exists
      if (searchQuery) {
        url.searchParams.append('q', searchQuery);
      }
      
      // Prevent caching
      url.searchParams.append('timestamp', Date.now());
      
      logDebug("Fetching URL:", url.toString());
      
      // Perform HTTP request
      const response = await fetch(url.toString(), {
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      
      // Process the response
      const data = await response.json();
      
      logDebug("API response received:", {
        products: data.products?.length || 0,
        totalCount: data.totalCount,
        estimatedTotalCount: data.estimatedTotalCount,
        productsWithMoreVariants: data.productsWithMoreVariants?.length || 0
      });
      
      // Check response data validity
      if (!data.products || !Array.isArray(data.products)) {
        console.error("Invalid data format - products is not an array:", data);
        throw new Error("Invalid data format received from server");
      }
      
      // Debug image URLs to identify issues
      debugImageUrls(data.products);
      
      // Store information about products with more variants
      if (data.productsWithMoreVariants && Array.isArray(data.productsWithMoreVariants)) {
        setProductsWithMoreVariants(data.productsWithMoreVariants);
      }
      
      // Update pagination states
      if (data.pageInfo) {
        setHasNextPage(data.pageInfo.hasNextPage);
        setHasPreviousPage(data.pageInfo.hasPreviousPage);
        setCursor(data.pageInfo.endCursor);
      }
      
      // Determine total variant count (using estimate if available)
      const totalCount = data.estimatedTotalCount !== undefined 
        ? data.estimatedTotalCount 
        : (data.totalCount || 0);
      
      // Update total count with proper handling for pagination
      if (page === 1) {
        setTotalAvailableProducts(totalCount);
      } else {
        // For subsequent pages, never decrease the total
        // and ensure it reflects at least the current elements
        const currentPageItems = data.products.reduce(
          (acc, product) => acc + (product.variants?.edges?.length || 0), 
          0
        );
        
        const minimumTotal = (page - 1) * childrenPerPage + currentPageItems;
        
        setTotalAvailableProducts(prev => Math.max(prev, minimumTotal, totalCount));
      }
      
      // Process variants from products
      const processedVariants = processVariantsFromProducts(data.products);
      
      logDebug("Processed variants:", processedVariants.length);
      
      // Update state with processed variants
      setAvailableProducts(processedVariants);
      
    } catch (error) {
      console.error('Error fetching available products:', error);
      setFetchError(error.message);
      setAvailableProducts([]);
      setError('Failed to load available products: ' + error.message);
    } finally {
      setLoadingProducts(false);
    }
  };
  
  /**
   * Debug function to identify image URL issues
   */
  const debugImageUrls = (products) => {
    console.log("===== DEBUGGING IMAGE URLS =====");
    
    // View complete structure of the first 3 variants
    const firstFewProducts = products.slice(0, 3);
    
    firstFewProducts.forEach((product, index) => {
      console.log(`Product ${index + 1}: ${product.title}`);
      console.log(`- Product Image URL:`, product.image);
      
      if (product.variants && product.variants.edges) {
        console.log(`- First variant image:`, product.variants.edges[0]?.node?.image);
      }
    });
    
    // Check how many variants have images
    let totalVariants = 0;
    let variantsWithImages = 0;
    
    products.forEach(product => {
      if (product.variants && product.variants.edges) {
        product.variants.edges.forEach(edge => {
          totalVariants++;
          if (edge.node.image) {
            variantsWithImages++;
          }
        });
      }
    });
    
    console.log(`Total variants: ${totalVariants}`);
    console.log(`Variants with images: ${variantsWithImages} (${Math.round(variantsWithImages/totalVariants*100)}%)`);
    console.log("================================");
  };
  
  /**
   * Processes variants from products received from API
   */
  const processVariantsFromProducts = (products) => {
    const processedVariants = [];
    
    // Build a map of master variants for reference
    const masterMap = {};
    
    // First pass to collect all masters
    products.forEach(product => {
      if (!product.variants || !product.variants.edges) return;
      
      product.variants.edges.forEach(edge => {
        const variant = edge.node;
        if (variant.isMaster) {
          masterMap[variant.id] = {
            productTitle: product.title,
            variantTitle: variant.title
          };
        }
      });
    });
    
    // Iterate over products to extract variants
    products.forEach(product => {
      if (!product.variants?.edges) return;
      
      const productImageUrl = product.image || product.images?.edges?.[0]?.node?.originalSrc || null;
      console.log(`Processing variants for product: ${product.title}, Product image: ${productImageUrl}`);
      
      product.variants.edges.forEach(edge => {
        const variant = edge.node;
        const variantImageUrl = variant.image?.originalSrc || null;
        console.log(`Variant: ${variant.title}, Image URL: ${variantImageUrl || 'none'}`);
        
        // Skip the current variant (can't add itself as a child)
        if (variant.id === variantId) return;
        
        // Determine availability
        let unavailable = false;
        let unavailableReason = "";
        
        // Check if already a child of this master
        if (currentChildren.includes(variant.id)) {
          unavailable = true;
          unavailableReason = "Already a child of this master";
        }
        
        // Check if it's a master variant
        else if (variant.isMaster) {
          unavailable = true;
          unavailableReason = "Already Master";
        }
        
        // Check if it has a parent master
        else if (variant.hasParentMaster && variant.parentMasterId && variant.parentMasterId !== variantId) {
          unavailable = true;
          
          // Try to find the parent master's details
          const masterDetails = masterMap[variant.parentMasterId];
          
          // Extract numeric ID from the GID for fallback
          const masterId = variant.parentMasterId ? variant.parentMasterId.split('/').pop() : '';
          
          // Use master details if available, otherwise show ID
          const masterTitle = masterDetails 
            ? `${masterDetails.variantTitle}`
            : `Master ${masterId}`;
          
          unavailableReason = `Child of ${masterTitle}`;
        }
        
        // Check direct metafield
        else if (variant.rawParentMasterValue && 
            variant.rawParentMasterValue !== "[]" && 
            variant.rawParentMasterValue !== "null") {
          unavailable = true;
          
          // Try to extract master ID from raw value
          let masterId = '';
          try {
            const parsedValue = JSON.parse(variant.rawParentMasterValue);
            if (Array.isArray(parsedValue) && parsedValue.length > 0) {
              masterId = parsedValue[0].split('/').pop() || '';
            }
          } catch (e) {
            masterId = variant.rawParentMasterValue.split('/').pop() || '';
          }
          
          unavailableReason = `Child of Master ${masterId}`;
        }
        
        // Get final image URL with fallbacks
        const finalImageUrl = variant.image?.originalSrc || productImageUrl || null;
        console.log(`Final image URL for variant ${variant.title}: ${finalImageUrl}`);
        
        // Add the processed variant to the list
        processedVariants.push({
          id: variant.id,
          title: variant.title,
          sku: variant.sku || '',
          productTitle: product.title,
          productId: product.id,
          image: finalImageUrl,
          unavailable: unavailable,
          unavailableReason: unavailableReason,
          hasParentMaster: variant.hasParentMaster || false,
          parentMasterId: variant.parentMasterId || null,
          rawParentMasterValue: variant.rawParentMasterValue || null
        });
      });
    });
    
    return processedVariants;
  };
  
  /**
   * Loads additional variants for a specific product
   */
  const loadMoreVariantsForProduct = async (productId, variantCursor) => {
    logDebug(`Loading more variants for product ${productId} with cursor ${variantCursor}`);
    
    try {
      setLoadingMoreVariants(true);
      
      // Build the API URL
      const url = new URL(`${window.location.origin}/api/bulk-products`);
      url.searchParams.append('productId', productId);
      url.searchParams.append('variantCursor', variantCursor);
      url.searchParams.append('timestamp', Date.now());
      
      // Perform HTTP request
      const response = await fetch(url.toString(), {
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      logDebug("Additional variants received:", {
        productId: data.productId,
        variantsCount: data.additionalVariants?.length || 0,
        hasMoreVariants: data.pageInfo?.hasNextPage
      });
      
      if (!data.additionalVariants || !Array.isArray(data.additionalVariants)) {
        console.error("Invalid data format for additional variants");
        return;
      }
      
      // Process additional variants
      const additionalProcessedVariants = data.additionalVariants.map(edge => {
        const variant = edge.node;
        
        // Skip the current variant
        if (variant.id === variantId) return null;
        
        // Determine availability (similar code as before)
        let unavailable = false;
        let unavailableReason = "";
        
        if (currentChildren.includes(variant.id)) {
          unavailable = true;
          unavailableReason = "Already a child of this master";
        } else if (variant.isMaster) {
          unavailable = true;
          unavailableReason = "Already Master";
        } else if (variant.hasParentMaster && variant.parentMasterId && variant.parentMasterId !== variantId) {
          unavailable = true;
          
          // Extract master ID from parent master ID
          const masterId = variant.parentMasterId ? variant.parentMasterId.split('/').pop() : '';
          unavailableReason = `Child of Master ${masterId}`;
        } else if (variant.rawParentMasterValue && 
            variant.rawParentMasterValue !== "[]" && 
            variant.rawParentMasterValue !== "null") {
          unavailable = true;
          
          // Try to extract master ID
          let masterId = '';
          try {
            const parsedValue = JSON.parse(variant.rawParentMasterValue);
            if (Array.isArray(parsedValue) && parsedValue.length > 0) {
              masterId = parsedValue[0].split('/').pop() || '';
            }
          } catch (e) {
            masterId = variant.rawParentMasterValue.split('/').pop() || '';
          }
          
          unavailableReason = `Child of Master ${masterId}`;
        }
        
        return {
          id: variant.id,
          title: variant.title,
          sku: variant.sku || '',
          productTitle: variant.productTitle || data.productTitle,
          productId: data.productId,
          image: variant.image?.originalSrc || null,
          unavailable: unavailable,
          unavailableReason: unavailableReason,
          hasParentMaster: variant.hasParentMaster || false,
          parentMasterId: variant.parentMasterId || null,
          rawParentMasterValue: variant.rawParentMasterValue || null
        };
      }).filter(v => v !== null);
      
      // Update available variants list
      setAvailableProducts(prev => [...prev, ...additionalProcessedVariants]);
      
      // Update the list of products with more variants
      setProductsWithMoreVariants(prev => {
        const updated = [...prev];
        const index = updated.findIndex(p => p.id === productId);
        
        if (index !== -1) {
          // If there are more variants, update the cursor
          if (data.pageInfo && data.pageInfo.hasNextPage) {
            updated[index].cursor = data.pageInfo.endCursor;
          } else {
            // If no more variants, remove the product from the list
            updated.splice(index, 1);
          }
        }
        
        return updated;
      });
      
      // Update total available products count
      setTotalAvailableProducts(prev => prev + additionalProcessedVariants.length);
      
    } catch (error) {
      console.error('Error loading more variants:', error);
      setError('Failed to load additional variants: ' + error.message);
    } finally {
      setLoadingMoreVariants(false);
    }
  };

  /**
   * Effect to load initial data when modal opens
   */
  useEffect(() => {
    if (open) {
      logDebug("Modal opened, initialising data");
      // Reset states
      setChildrenPage(1);
      setChildSearchQuery('');
      setCursor(null);
      setFetchError(null);
      setProductsWithMoreVariants([]);
      
      // Fetch initial data
      fetchAvailableProducts(1, '', null);
    }
  }, [open]);

  /**
   * Handles previous page navigation
   */
  const handlePreviousPage = () => {
    if (childrenPage > 1) {
      const newPage = childrenPage - 1;
      logDebug(`Going to previous page: ${newPage}`);
      setChildrenPage(newPage);
      fetchAvailableProducts(newPage, childSearchQuery, null);
    }
  };
  
  /**
   * Handles next page navigation
   */
  const handleNextPage = () => {
    const newPage = childrenPage + 1;
    logDebug(`Going to next page: ${newPage}`);
    setChildrenPage(newPage);
    fetchAvailableProducts(newPage, childSearchQuery, cursor);
  };
  
  /**
   * Handles search query changes in the Add Children modal
   * 
   * @param {string} query - The search query entered by the user
   */
  const handleChildrenSearch = (query) => {
    logDebug("Handling search query:", query);
    setChildSearchQuery(query);
    setChildrenPage(1);
    setCursor(null);
    fetchAvailableProducts(1, query, null);
  };
  
  /**
   * Handles adding a child variant
   * 
   * @param {string} childId - The ID of the variant to add as a child
   */
  const handleAddChild = async (childId) => {
    try {
      // Check if this child is already in the children array
      if (currentChildren.includes(childId)) {
        setError('This variant is already a child of this master.');
        return;
      }
      
      // Find the variant in our available products list
      const productToAdd = availableProducts.find(p => p.id === childId);
      
      // Safety check: Don't allow adding if the variant is unavailable
      if (productToAdd && productToAdd.unavailable) {
        setError(`Cannot add this variant. ${productToAdd.unavailableReason}`);
        return;
      }
      
      // Additional safety check: verify no parent master exists
      if (productToAdd && productToAdd.hasParentMaster && productToAdd.parentMasterId !== variantId) {
        setError(`Cannot add this variant as it already has a parent master assigned. A variant can only be a child of one master at a time.`);
        return;
      }
      
      // Call the parent component's callback to add the child
      await onAddChild(childId);
      
      // Remove the added child from available products
      setAvailableProducts(prev => prev.filter(product => product.id !== childId));
      
      // Reduce total by 1
      setTotalAvailableProducts(prev => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Error adding child:', err);
      setError(err.message);
    }
  };
  
  // Calculate current page range with corrections for display
  const displayStart = (childrenPage - 1) * childrenPerPage + 1;
  
  // Ensure the display end is never less than the start value
  const displayEnd = Math.max(
    displayStart, 
    displayStart + availableProducts.length - 1
  );
  
  // Ensure the total is consistent with the displayed range
  const displayTotal = Math.max(displayEnd, totalAvailableProducts);
  
  // Markup to display pagination information
  const paginationMarkup = () => {
    // If there are errors, don't show pagination
    if (fetchError) {
      return null;
    }
    
    // If no products, show informative message
    if (availableProducts.length === 0) {
      return (
        <Text variant="bodyMd" color="subdued">
          No variants found
        </Text>
      );
    }
    
    // To avoid showing "0 of 0 variants"
    if (totalAvailableProducts === 0) {
      return (
        <Text variant="bodyMd" color="subdued">
          Showing {availableProducts.length} variants
        </Text>
      );
    }
    
    // If there are enough products or more pages, show complete pagination
    if (hasNextPage || childrenPage > 1) {
      return (
        <Pagination
          hasPrevious={childrenPage > 1}
          onPrevious={handlePreviousPage}
          hasNext={hasNextPage}
          onNext={handleNextPage}
          label={`${displayStart}-${displayEnd} of ${displayTotal}+ variants`}
        />
      );
    }
    
    // If only one page, show simple text with correct values
    return (
      <Text variant="bodyMd" color="subdued">
        Showing {displayStart}-{displayEnd} of {displayTotal}+ variants
      </Text>
    );
  };

  // Main content to display
  const renderContent = () => {
    // If loading, show spinner
    if (loadingProducts) {
      return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
          <Spinner accessibilityLabel="Loading products" size="large" />
        </div>
      );
    }
    
    // If there's an error, show error message
    if (fetchError) {
      return (
        <Banner status="critical">
          <p>Error loading variants: {fetchError}</p>
          <div style={{ marginTop: '10px' }}>
            <Button onClick={() => fetchAvailableProducts(1, childSearchQuery, null)}>
              Retry Loading
            </Button>
          </div>
        </Banner>
      );
    }
    
    // If no available variants
    if (availableProducts.length === 0) {
      return (
        <EmptyState
          heading="No available variants found"
          image=""
        >
          <p>
            {childSearchQuery 
              ? 'Try a different search term or check for variants that are not already assigned to other masters.' 
              : 'There are no available variants to add as children. Create more variants or free existing variants from other masters.'}
          </p>
          <div style={{ marginTop: '15px' }}>
            <Button onClick={() => fetchAvailableProducts(1, '', null)}>
              Refresh Variants
            </Button>
          </div>
        </EmptyState>
      );
    }
    
    // Render buttons to load more variants if there are products with more variants
    const loadMoreButtons = productsWithMoreVariants.length > 0 && (
      <div style={{ 
        marginTop: '8px', 
        marginBottom: '16px', 
        padding: '8px', 
        backgroundColor: '#f5f5f5', 
        borderRadius: '4px'
      }}>
        <Text variant="headingSm" as="h3">
          Some products have more variants available:
        </Text>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
          {productsWithMoreVariants.map(product => (
            <Button
              key={product.id}
              size="slim"
              onClick={() => loadMoreVariantsForProduct(product.id, product.cursor)}
              loading={loadingMoreVariants}
              disabled={loadingMoreVariants}
            >
              Load more from {product.title}
            </Button>
          ))}
        </div>
      </div>
    );
    
    // If there are variants, show the table
    return (
      <>
        {loadMoreButtons}
        <table className="PolarisTEMPTable" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ 
                padding: '12px 16px', 
                borderBottom: '1px solid #ddd', 
                textAlign: 'left',
                width: '70px'
              }}>
                Image
              </th>
              <th style={{ 
                padding: '12px 16px', 
                borderBottom: '1px solid #ddd', 
                textAlign: 'left' 
              }}>
                Product
              </th>
              <th style={{ 
                padding: '12px 16px', 
                borderBottom: '1px solid #ddd', 
                textAlign: 'left' 
              }}>
                Variant
              </th>
              <th style={{ 
                padding: '12px 16px', 
                borderBottom: '1px solid #ddd', 
                textAlign: 'left',
                width: '120px'
              }}>
                SKU
              </th>
              <th style={{ 
                padding: '12px 16px', 
                borderBottom: '1px solid #ddd', 
                textAlign: 'left',
                width: '130px'
              }}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {availableProducts.map(product => (
              <tr key={product.id}>
                <td style={{ 
                  padding: '12px 16px', 
                  borderBottom: '1px solid #f1f1f1' 
                }}>
                  <VariantImage 
                    src={product.image} 
                    alt={product.title} 
                    size="medium"
                  />
                </td>
                <td style={{ 
                  padding: '12px 16px', 
                  borderBottom: '1px solid #f1f1f1' 
                }}>
                  <Text variant="bodyMd" as="p">
                    {product.productTitle}
                  </Text>
                </td>
                <td style={{ 
                  padding: '12px 16px', 
                  borderBottom: '1px solid #f1f1f1' 
                }}>
                  <Text variant="bodyMd" as="p" fontWeight="semibold">
                    {product.title || "Unknown"}
                  </Text>
                  <Text variant="bodySm" as="p" color="subdued">
                    ID: {product.id.split('/').pop() || product.id}
                  </Text>
                </td>
                <td style={{ 
                  padding: '12px 16px', 
                  borderBottom: '1px solid #f1f1f1' 
                }}>
                  <Text variant="bodyMd" as="p">
                    {product.sku || "—"}
                  </Text>
                </td>
                <td style={{ 
                  padding: '12px 16px', 
                  borderBottom: '1px solid #f1f1f1' 
                }}>
                  {product.unavailable ? (
                    <div style={{ 
                      color: '#bf0711', 
                      backgroundColor: '#fbeae5',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      fontSize: '0.85rem',
                      fontWeight: '500'
                    }}>
                      {product.unavailableReason || "Already assigned to another master"}
                    </div>
                  ) : (
                    <Button 
                      primary
                      size="medium"
                      onClick={() => handleAddChild(product.id)}
                    >
                      Add
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Child Variants"
      size="large"
    >
      <Modal.Section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Text variant="bodyMd" as="p">
            Select variants to add as children to this master variant. Child variants will be linked to this master for inventory synchronisation.
          </Text>
          
          {/* Search field */}
          <TextField
            label="Search"
            value={childSearchQuery}
            onChange={(value) => {
              setChildSearchQuery(value);
              handleChildrenSearch(value);
            }}
            placeholder="Search by product title, variant title or SKU"
            clearButton
            onClearButtonClick={() => {
              setChildSearchQuery('');
              handleChildrenSearch('');
            }}
          />
          
          <Card>
            <div style={{ maxHeight: '500px', overflowY: 'auto' }}>
              {renderContent()}
            </div>
          </Card>
          
          {/* Pagination controls */}
          <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
            {paginationMarkup()}
          </div>
        </div>
      </Modal.Section>
      
      <Modal.Section>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal.Section>
    </Modal>
  );
}