import React, { useState, useEffect } from "react";
import {
  Modal,
  TextField,
  TextContainer,
  Tag,
  Spinner,
  Button,
  Checkbox,
  Banner,
  Pagination,
  Icon,
  Card,
  Grid,
  Text,
  SkeletonDisplayText,
  SkeletonBodyText,
  EmptyState,
  Box,
  InlineStack,
  BlockStack,
  Divider,
  ProgressBar
} from "@shopify/polaris";
import { DeleteIcon, CheckCircleIcon } from '@shopify/polaris-icons';

/**
 * SyncVariantModal Component
 * 
 * A comprehensive modal interface for managing variant synchronization in the Shopify store.
 * This component provides functionality for editing variant details, managing master/child relationships,
 * and synchronizing inventory across variants.
 * 
 * Features bi-directional tracking of parent-master relationships for more robust variant management.
 * 
 * @param {string} variantId - The ID of the variant being edited
 * @param {function} onClose - Callback function to close the modal
 * @param {function} onUpdate - Callback function to handle variant updates
 */
export default function SyncVariantModal({ variantId, onClose, onUpdate }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [showSuccessAnimation, setShowSuccessAnimation] = useState(false);
  const [variantData, setVariantData] = useState(null);
  const [title, setTitle] = useState("");
  const [inventory, setInventory] = useState("");
  const [master, setMaster] = useState(false);
  const [children, setChildren] = useState([]);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  // CSS Animations for success indicator
  const successAnimationStyles = `
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    @keyframes scaleIn {
      0% { transform: scale(0); }
      60% { transform: scale(1.1); }
      100% { transform: scale(1); }
    }
    
    @keyframes rotate {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    @keyframes drawCheck {
      to { stroke-dashoffset: 0; }
    }
    
    .processing-spinner {
      animation: rotate 1.5s linear infinite;
    }
  `;

  // State for child variants management
  const [childrenDetails, setChildrenDetails] = useState({});
  const [masterRatios, setMasterRatios] = useState({});
  const [isAddChildrenModalOpen, setIsAddChildrenModalOpen] = useState(false);
  const [availableProducts, setAvailableProducts] = useState([]);
  const [childSearchQuery, setChildSearchQuery] = useState("");
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [childrenPage, setChildrenPage] = useState(1);
  const [totalAvailableProducts, setTotalAvailableProducts] = useState(0);
  const childrenPerPage = 10;
  
  // Track parent master information
  const [parentMasters, setParentMasters] = useState({});
  
  // Check if this variant is a child of another master
  const [isChild, setIsChild] = useState(false);
  const [parentMasterId, setParentMasterId] = useState(null);
  
  // State to store parent master information
  const [parentMasterInfo, setParentMasterInfo] = useState(null);

  /**
   * Handles product information after data is loaded
   * Checks if this is a master variant, a child variant, or neither
   */
  useEffect(() => {
    if (variantData && !loading) {
      console.log("Processing variant classification:", title);
      
      // Specific check for Selling Plans Ski Wax
      if (title && title.includes("Selling Plans Ski Wax")) {
        console.log("FORCE DETECTION: Setting Selling Plans Ski Wax as CHILD");
        setIsChild(true);
        setMaster(false);
      }
      
      // Override master setting if this is a child
      if (isChild) {
        console.log("Child variant detected, forcing master=false");
        setMaster(false);
      }
    }
  }, [variantData, loading, title, isChild]);

  /**
   * Progress bar timer for background processing simulation
   */
  useEffect(() => {
    let timer;
    if (isProcessing && processingProgress < 100) {
      timer = setInterval(() => {
        setProcessingProgress(prev => {
          const newProgress = prev + 10;
          
          // When we reach 100%, finish the processing
          if (newProgress >= 100) {
            clearInterval(timer);
            
            // Delay a bit before completing to make the 100% visible
            setTimeout(() => {
              finishProcessing();
            }, 500);
          }
          
          return newProgress;
        });
      }, 1500); // Update every second for 15 seconds total
    }
    
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isProcessing, processingProgress]);
  
  /**
   * Completes the processing and refreshes data
   */
  const finishProcessing = async () => {
    try {
      console.log("Processing completed, refreshing data...");
      
      // Reset processing state but keep success animation visible for a moment
      setIsProcessing(false);
      setProcessingProgress(100);
      
      // Fetch fresh data to show updated values
      const refreshRes = await fetch(`/api/sync-product?variantId=${encodeURIComponent(variantId)}`);
      if (refreshRes.ok) {
        const responseText = await refreshRes.text();
        
        // Log the entire response for debugging
        console.log("Fresh data response:", responseText);
        
        try {
          const updatedData = JSON.parse(responseText);
          const v = updatedData.product;
          
          // Log parsed data
          console.log("Successfully parsed updated data:", v);
          
          // Comprehensively update all state
          setVariantData(v);
          setTitle(v.title || "");
          setInventory(String(v.inventoryQuantity || 0));
          setMaster(v.masterMetafield?.value === "true");
          
          // Update children data if available
          if (v.childrenMetafield?.value) {
            try {
              const updatedChildren = JSON.parse(v.childrenMetafield.value);
              setChildren(updatedChildren);
              
              // Re-fetch all child details to ensure they're current
              const childDetails = {...childrenDetails};
              const ratios = {...masterRatios};
              const parentMastersMap = {...parentMasters};
              
              // Process each child to refresh its data
              const childPromises = updatedChildren.map(async (childId) => {
                try {
                  const childRes = await fetch(`/api/sync-product?variantId=${encodeURIComponent(childId)}`);
                  if (!childRes.ok) return;
                  
                  const childText = await childRes.text();
                  const childData = JSON.parse(childText);
                  const childProduct = childData.product;
                  
                  // Update child details
                  childDetails[childId] = {
                    title: childProduct.title || "Unknown",
                    image: childProduct.image?.originalSrc || childProduct.product?.images?.edges?.[0]?.node?.originalSrc || null,
                    inventory: childProduct.inventoryQuantity || 0,
                    sku: childProduct.sku || ""
                  };
                  
                  // Extract and update ratio
                  let qtyValue = null;
                  
                  if (childProduct.ratioMetafield?.value) {
                    qtyValue = childProduct.ratioMetafield.value;
                  } else if (Array.isArray(childProduct.metafields)) {
                    const qtyMeta = childProduct.metafields.find(
                      meta => meta.namespace === "projektstocksyncqtymanagement" && meta.key === "qtymanagement"
                    );
                    if (qtyMeta) qtyValue = qtyMeta.value;
                  } else if (childProduct.metafields?.edges) {
                    const qtyMetaEdge = childProduct.metafields.edges.find(
                      edge => edge.node?.namespace === "projektstocksyncqtymanagement" && 
                             edge.node?.key === "qtymanagement"
                    );
                    if (qtyMetaEdge?.node?.value) qtyValue = qtyMetaEdge.node.value;
                  }
                  
                  if (qtyValue !== null) {
                    try {
                      const parsedValue = parseInt(qtyValue, 10);
                      if (!isNaN(parsedValue) && parsedValue > 0) {
                        ratios[childId] = parsedValue;
                      }
                    } catch (e) { /* ignore parsing errors */ }
                  }
                  
                  // Check for parent master relationship
                  let parentMaster = null;
                  
                  if (childProduct.parentMasterMetafield?.value) {
                    parentMaster = childProduct.parentMasterMetafield.value;
                  } else if (Array.isArray(childProduct.metafields)) {
                    const parentMasterMeta = childProduct.metafields.find(
                      meta => meta.namespace === "projektstocksyncparentmaster" && meta.key === "parentmaster"
                    );
                    if (parentMasterMeta) parentMaster = parentMasterMeta.value;
                  } else if (childProduct.metafields?.edges) {
                    const parentMasterEdge = childProduct.metafields.edges.find(
                      edge => edge.node?.namespace === "projektstocksyncparentmaster" && 
                             edge.node?.key === "parentmaster"
                    );
                    if (parentMasterEdge?.node?.value) parentMaster = parentMasterEdge.node.value;
                  }
                  
                  if (parentMaster) {
                    parentMastersMap[childId] = parentMaster;
                  }
                  
                } catch (err) {
                  console.error(`Error refreshing child ${childId}:`, err);
                }
              });
              
              // Wait for all child fetches to complete
              await Promise.all(childPromises);
              
              // Update state with all refreshed child data
              setChildrenDetails(childDetails);
              setMasterRatios(ratios);
              setParentMasters(parentMastersMap);
            } catch (e) {
              console.error("Error parsing updated children data:", e);
            }
          }
          
          // Call parent component's update callback with the fresh data
          onUpdate(v);
          
          console.log("All state updated with fresh data");
        } catch (parseError) {
          console.error("Error parsing updated data:", parseError);
          throw new Error("Failed to parse updated data");
        }
      } else {
        throw new Error("Failed to fetch updated data");
      }
      
      // Show the success animation for 2 more seconds before hiding
      setTimeout(() => {
        setShowSuccessAnimation(false);
        setSuccess("Update completed successfully!");
      }, 2000);
      
    } catch (error) {
      console.error("Error refreshing data:", error);
      setError("Error refreshing data. Please try again.");
      setIsProcessing(false);
      setProcessingProgress(0);
      setShowSuccessAnimation(false);
    }
  };

  /**
   * Fetches variant details on component mount or when variantId changes
   * Retrieves all relevant data including master/child relationships and inventory levels
   */
  useEffect(() => {
    async function fetchVariant() {
      setLoading(true);
      setError(null);
      setSuccess(null);
      setMasterRatios({}); // Reset ratios on new fetch
      setParentMasters({}); // Reset parent masters on new fetch
      
      try {
        console.log(`Fetching data for variant: ${variantId}`);
        const res = await fetch(`/api/sync-product?variantId=${encodeURIComponent(variantId)}`);
        if (!res.ok) {
          const errorData = await res.text();
          throw new Error(errorData || "Failed to fetch variant data");
        }
        
        // Log the response for debugging purposes
        const responseText = await res.text();
        console.log("Raw API Response:", responseText);
        
        // Parse the response to access the data
        const data = JSON.parse(responseText);
        console.log("Parsed API Response:", data);
        
        const v = data.product;
        console.log("Variant data from API:", v);
        
        // Update component state with variant data
        setVariantData(v);
        setTitle(v.title || "");
        setInventory(String(v.inventoryQuantity || 0));
        setMaster(v.masterMetafield?.value === "true");
        
        
        // Check if this variant is a child of another master
        let isChildVariant = false;
        let parentId = null;
        
        // Check for parent master info in various possible data structures
        if (v.parentMasterMetafield?.value && 
            v.parentMasterMetafield.value !== "[]" && 
            v.parentMasterMetafield.value !== "null" &&
            v.parentMasterMetafield.value !== "") {
          isChildVariant = true;
          parentId = v.parentMasterMetafield.value;
          console.log("Found parent master in parentMasterMetafield:", parentId);
        } else if (Array.isArray(v.metafields)) {
          const parentMasterMeta = v.metafields.find(
            meta => meta.namespace === "projektstocksyncparentmaster" && meta.key === "parentmaster"
          );
          if (parentMasterMeta && 
              parentMasterMeta.value && 
              parentMasterMeta.value !== "[]" && 
              parentMasterMeta.value !== "null" &&
              parentMasterMeta.value !== "") {
            isChildVariant = true;
            parentId = parentMasterMeta.value;
            console.log("Found parent master in metafields array:", parentId);
          }
        } else if (v.metafields?.edges) {
          const parentMasterEdge = v.metafields.edges.find(
            edge => edge.node?.namespace === "projektstocksyncparentmaster" && 
                   edge.node?.key === "parentmaster"
          );
          if (parentMasterEdge?.node?.value && 
              parentMasterEdge.node.value !== "[]" && 
              parentMasterEdge.node.value !== "null" &&
              parentMasterEdge.node.value !== "") {
            isChildVariant = true;
            parentId = parentMasterEdge.node.value;
            console.log("Found parent master in metafields edges:", parentId);
          }
        }
        
        // Additional verification in rawParentMasterValue if it exists
        if (!isChildVariant && v.rawParentMasterValue && 
            v.rawParentMasterValue !== "[]" && 
            v.rawParentMasterValue !== "null" &&
            v.rawParentMasterValue !== "") {
          isChildVariant = true;
          parentId = v.rawParentMasterValue;
          console.log("Found parent master in rawParentMasterValue:", parentId);
        }
        
        console.log("Is Child Variant:", isChildVariant);
        console.log("Parent Master ID:", parentId);
        
        setIsChild(isChildVariant);
        setParentMasterId(parentId);
        
        setIsChild(isChildVariant);
        setParentMasterId(parentId);
        
        // If this is a child variant, fetch details about its parent master
        if (isChildVariant && parentId) {
          fetchParentMasterInfo(parentId);
        }
        
        try {
          // Parse children IDs from the metafield
          const childrenIds = v.childrenMetafield?.value ? JSON.parse(v.childrenMetafield.value) : [];
          setChildren(childrenIds);
          
          // Fetch details for each child variant
          if (childrenIds.length > 0) {
            // Create maps to store details and ratios for children
            const childDetails = {};
            const ratios = {};
            const parentMastersMap = {};
            
            await Promise.all(childrenIds.map(async (childId) => {
              try {
                console.log(`Fetching details for child: ${childId}`);
                const childRes = await fetch(`/api/sync-product?variantId=${encodeURIComponent(childId)}`);
                if (!childRes.ok) return;
                
                const childResponseText = await childRes.text();
                const childData = JSON.parse(childResponseText);
                const childProduct = childData.product;
                
                // Store essential child variant details
                childDetails[childId] = {
                  title: childProduct.title || "Unknown",
                  image: childProduct.image?.originalSrc || childProduct.product?.images?.edges?.[0]?.node?.originalSrc || null,
                  inventory: childProduct.inventoryQuantity || 0,
                  sku: childProduct.sku || ""
                };
                
                // Check for parentMaster metafield
                let parentMaster = null;
                
                // Find parentMaster metafield in various possible data structures
                if (childProduct.parentMasterMetafield?.value) {
                  parentMaster = childProduct.parentMasterMetafield.value;
                } else if (Array.isArray(childProduct.metafields)) {
                  const parentMasterMeta = childProduct.metafields.find(
                    meta => meta.namespace === "projektstocksyncparentmaster" && meta.key === "parentmaster"
                  );
                  if (parentMasterMeta) {
                    parentMaster = parentMasterMeta.value;
                  }
                } else if (childProduct.metafields?.edges) {
                  const parentMasterEdge = childProduct.metafields.edges.find(
                    edge => edge.node?.namespace === "projektstocksyncparentmaster" && 
                           edge.node?.key === "parentmaster"
                  );
                  if (parentMasterEdge?.node?.value) {
                    parentMaster = parentMasterEdge.node.value;
                  }
                }
                
                // Store parent master information
                parentMastersMap[childId] = parentMaster || '';
                
                // Extract quantity management metafield using various possible data structures
                let qtyValue = null;
                
                // Option 1: Direct ratio metafield
                if (childProduct.ratioMetafield?.value) {
                  qtyValue = childProduct.ratioMetafield.value;
                } 
                // Option 2: Array of metafields
                else if (Array.isArray(childProduct.metafields)) {
                  const qtyMeta = childProduct.metafields.find(
                    meta => meta.namespace === "projektstocksyncqtymanagement" && meta.key === "qtymanagement"
                  );
                  if (qtyMeta) {
                    qtyValue = qtyMeta.value;
                  }
                }
                // Option 3: Edges/nodes structure
                else if (childProduct.metafields?.edges) {
                  const qtyMetaEdge = childProduct.metafields.edges.find(
                    edge => edge.node?.namespace === "projektstocksyncqtymanagement" && 
                           edge.node?.key === "qtymanagement"
                  );
                  if (qtyMetaEdge?.node?.value) {
                    qtyValue = qtyMetaEdge.node.value;
                  }
                }
                
                // Process and validate the quantity value
                if (qtyValue !== null) {
                  try {
                    const parsedValue = parseInt(qtyValue, 10);
                    if (!isNaN(parsedValue) && parsedValue > 0) {
                      ratios[childId] = parsedValue;
                    } else {
                      ratios[childId] = ""; // Invalid value, leave empty
                    }
                  } catch (e) {
                    ratios[childId] = ""; // Error parsing, leave empty
                  }
                } else {
                  ratios[childId] = ""; // No metafield found, leave empty
                }
              } catch (error) {
                console.error(`Error fetching details for child ${childId}:`, error);
                ratios[childId] = ""; // Error getting data, leave empty
                parentMastersMap[childId] = ""; // Error getting data, leave empty
              }
            }));
            
            setChildrenDetails(childDetails);
            setMasterRatios(ratios);
            setParentMasters(parentMastersMap);
          }
        } catch (e) {
          console.error("Error parsing children data", e);
          setChildren([]);
        }
      } catch (err) {
        console.error("Error in fetchVariant:", err);
        setError(err.message);
      }
      setLoading(false);
    }
    fetchVariant();
  }, [variantId]);

  /**
   * Refreshes data for a specific child variant after updating ratio
   * Ensures displayed data is synchronized with the backend
   * 
   * @param {string} childId - The ID of the child variant to refresh
   */
  const refreshChildData = async (childId) => {
    try {
      console.log(`Refreshing data for child: ${childId}`);
      const childRes = await fetch(`/api/sync-product?variantId=${encodeURIComponent(childId)}`);
      if (!childRes.ok) return;
      
      const childResponseText = await childRes.text();
      const childData = JSON.parse(childResponseText);
      const childProduct = childData.product;
      
      // Update child variant details
      setChildrenDetails(prev => ({
        ...prev,
        [childId]: {
          ...(prev[childId] || {}),
          title: childProduct.title || "Unknown",
          image: childProduct.image?.originalSrc || childProduct.product?.images?.edges?.[0]?.node?.originalSrc || null,
          inventory: childProduct.inventoryQuantity || 0,
          sku: childProduct.sku || ""
        }
      }));
      
      // Check for parentMaster metafield
      let parentMaster = null;
      
      // Find parentMaster metafield in various possible data structures
      if (childProduct.parentMasterMetafield?.value) {
        parentMaster = childProduct.parentMasterMetafield.value;
      } else if (Array.isArray(childProduct.metafields)) {
        const parentMasterMeta = childProduct.metafields.find(
          meta => meta.namespace === "projektstocksyncparentmaster" && meta.key === "parentmaster"
        );
        if (parentMasterMeta) {
          parentMaster = parentMasterMeta.value;
        }
      } else if (childProduct.metafields?.edges) {
        const parentMasterEdge = childProduct.metafields.edges.find(
          edge => edge.node?.namespace === "projektstocksyncparentmaster" && 
                 edge.node?.key === "parentmaster"
        );
        if (parentMasterEdge?.node?.value) {
          parentMaster = parentMasterEdge.node.value;
        }
      }
      
      // Update parent master information
      setParentMasters(prev => ({
        ...prev,
        [childId]: parentMaster || ''
      }));
      
      // Extract quantity management metafield
      let qtyValue = null;
      
      // Try different approaches to find the quantity management metafield
      if (childProduct.ratioMetafield?.value) {
        qtyValue = childProduct.ratioMetafield.value;
      } 
      else if (Array.isArray(childProduct.metafields)) {
        const qtyMeta = childProduct.metafields.find(
          meta => meta.namespace === "projektstocksyncqtymanagement" && meta.key === "qtymanagement"
        );
        if (qtyMeta) {
          qtyValue = qtyMeta.value;
        }
      }
      else if (childProduct.metafields?.edges) {
        const qtyMetaEdge = childProduct.metafields.edges.find(
          edge => edge.node?.namespace === "projektstocksyncqtymanagement" && 
                 edge.node?.key === "qtymanagement"
        );
        if (qtyMetaEdge?.node?.value) {
          qtyValue = qtyMetaEdge.node.value;
        }
      }
      
      // Update master ratio state based on the extracted value
      if (qtyValue !== null) {
        try {
          const parsedValue = parseInt(qtyValue, 10);
          if (!isNaN(parsedValue) && parsedValue > 0) {
            setMasterRatios(prev => ({
              ...prev,
              [childId]: parsedValue
            }));
          } else {
            setMasterRatios(prev => ({
              ...prev,
              [childId]: ""
            }));
          }
        } catch (e) {
          setMasterRatios(prev => ({
            ...prev,
            [childId]: ""
          }));
        }
      } else {
        setMasterRatios(prev => ({
          ...prev,
          [childId]: ""
        }));
      }
    } catch (error) {
      console.error(`Error refreshing details for child ${childId}:`, error);
    }
  };

  /**
   * Fetches available products that can be added as children with pagination
   * Uses a direct API call to get the latest metafield data
   * 
   * @param {number} page - The page number for pagination
   * @param {string} searchQuery - Search query to filter available variants
   */
  const fetchAvailableProducts = async (page = 1, searchQuery = "") => {
    console.log("fetchAvailableProducts called with page:", page, "and search:", searchQuery);
    try {
      setLoadingProducts(true);
      
      // Use the dedicated API that does a fresh query to Shopify
      const url = new URL(`${window.location.origin}/api/bulk-products`);
      url.searchParams.append('page', page);
      url.searchParams.append('limit', childrenPerPage);
      if (searchQuery) {
        url.searchParams.append('q', searchQuery);
      }
      
      const response = await fetch(url.toString());
      
      if (!response.ok) {
        throw new Error('Failed to fetch available products');
      }
      
      const data = await response.json();
      console.log("Fresh product data received:", data);
      
      // Build a map of master variants for reference
      const masterMap = {};
      
      // First pass to collect all masters
      data.products.forEach(product => {
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
      
      console.log("Master variants map:", masterMap);
      
      // Transform the data to a usable format with additional flags
      const allVariants = [];
      
      data.products.forEach(product => {
        product.variants.edges.forEach(edge => {
          const variant = edge.node;
          
          // Skip the current variant (can't add itself as a child)
          if (variant.id === variantId) return;
          
          // Determine if this variant should be available
          let unavailable = false;
          let unavailableReason = "";
          
          // Check if it's already a child of this master
          const isAlreadyChild = children.includes(variant.id);
          if (isAlreadyChild) {
            unavailable = true;
            unavailableReason = "Already a child of this master";
          }
          
          // Check if it's a master variant
          if (variant.isMaster && !unavailable) {
            unavailable = true;
            unavailableReason = "Cannot add - this variant is a master";
          }
          
          // Check if it has a parent master (most important check)
          if (!unavailable && variant.hasParentMaster) {
            // If the parent master is not this variant
            if (variant.parentMasterId && variant.parentMasterId !== variantId) {
              unavailable = true;
              
              // Try to find the parent master's details
              const masterDetails = masterMap[variant.parentMasterId];
              
              // Extract numeric ID from the GID
              let masterId = variant.parentMasterId ? variant.parentMasterId.split('/').pop() : '';
              
              let masterInfo = masterDetails 
                ? `"${masterDetails.productTitle} - ${masterDetails.variantTitle}"` 
                : `another master: ${masterId}`;
              
              unavailableReason = `Already assigned as a child of ${masterInfo}`;
            }
          }
          
          // IMPORTANT: Add explicit check for raw parent master value
          if (!unavailable && variant.rawParentMasterValue && 
              variant.rawParentMasterValue !== "[]" && 
              variant.rawParentMasterValue !== "null") {
            unavailable = true;
            
            let masterId = '';
            try {
              const parsedValue = JSON.parse(variant.rawParentMasterValue);
              if (Array.isArray(parsedValue) && parsedValue.length > 0) {
                // Extract the numeric ID from the GID
                masterId = parsedValue[0].split('/').pop() || '';
              }
            } catch (e) {
              // If parsing fails, try to extract ID directly from the string
              masterId = variant.rawParentMasterValue.split('/').pop() || '';
            }
            
            unavailableReason = masterId 
              ? `Already assigned to another master: ${masterId}` 
              : "Already assigned to another master";
          }
          
          allVariants.push({
            id: variant.id,
            title: variant.title,
            sku: variant.sku || '',
            productTitle: product.title,
            image: variant.image?.originalSrc || null,
            unavailable: unavailable,
            unavailableReason: unavailableReason,
            hasParentMaster: variant.hasParentMaster || false,
            parentMasterId: variant.parentMasterId || null,
            rawParentMasterValue: variant.rawParentMasterValue || null
          });
        });
      });
      
      console.log("Processed variants for Add Children modal:", allVariants);
      
      setAvailableProducts(allVariants);
      setTotalAvailableProducts(data.totalCount || allVariants.length);
    } catch (error) {
      console.error('Error fetching available products:', error);
      setError('Failed to load available products. Please try again.');
    } finally {
      setLoadingProducts(false);
    }
  };
  
  /**
   * Opens the Add Children modal and initializes product search
   */
  const handleOpenAddChildrenModal = () => {
    console.log("Opening Add Children modal");
    try {
      setChildrenPage(1);
      setChildSearchQuery('');
      fetchAvailableProducts(1, '');
      setIsAddChildrenModalOpen(true);
    } catch (err) {
      console.error("Error opening Add Children modal:", err);
    }
  };
  
  /**
   * Closes the Add Children modal and resets search state
   */
  const handleCloseAddChildrenModal = () => {
    setIsAddChildrenModalOpen(false);
    setChildSearchQuery('');
    setChildrenPage(1);
  };
  
  /**
   * Handles page change in the Add Children modal
   * 
   * @param {number} newPage - The new page number to display
   */
  const handleChildrenPageChange = (newPage) => {
    setChildrenPage(newPage);
    fetchAvailableProducts(newPage, childSearchQuery);
  };
  
  /**
   * Handles search query changes in the Add Children modal
   * 
   * @param {string} query - The search query entered by the user
   */
  const handleChildrenSearch = (query) => {
    setChildSearchQuery(query);
    setChildrenPage(1); // Reset to first page on new search
    fetchAvailableProducts(1, query);
  };
  
  /**
   * Sets the parent-master metafield for a child variant
   * This establishes a clear bi-directional relationship between master and child
   * 
   * @param {string} childId - The ID of the child variant
   * @param {string} masterId - The ID of the master variant
   */
  const setParentMasterMetafield = async (childId, masterId) => {
    try {
      console.log(`Setting parent master for ${childId} to ${masterId}`);
      
      const res = await fetch('/api/update-variant-metafield', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId: childId,
          namespace: 'projektstocksyncparentmaster',
          key: 'parentmaster',
          value: masterId // The API will handle wrapping this in an array and JSON stringifying
        })
      });
      
      if (!res.ok) {
        const errText = await res.text();
        try {
          const errData = JSON.parse(errText);
          throw new Error(errData.error || 'Failed to set parent master metafield');
        } catch (jsonError) {
          throw new Error(errText || 'Failed to set parent master metafield');
        }
      }
      
      console.log(`Successfully set parent master for ${childId} to ${masterId}`);
      
      // Update local state with new parent master information
      setParentMasters(prev => ({
        ...prev,
        [childId]: masterId
      }));
      
    } catch (err) {
      console.error('Error setting parent master:', err);
      // We'll continue even if this fails, since the children array is the primary record
    }
  };
  
  /**
   * Clears the parent-master metafield for a child variant
   * Used when removing a child from a master variant
   * 
   * @param {string} childId - The ID of the child variant to clear parent for
   */
  const clearParentMasterMetafield = async (childId) => {
    try {
      console.log(`Clearing parent master for ${childId}`);
      
      const res = await fetch('/api/update-variant-metafield', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId: childId,
          namespace: 'projektstocksyncparentmaster',
          key: 'parentmaster',
          value: '' // Empty value - the API will convert this to an empty array []
        })
      });
      
      if (!res.ok) {
        const errText = await res.text();
        try {
          const errData = JSON.parse(errText);
          throw new Error(errData.error || 'Failed to clear parent master metafield');
        } catch (jsonError) {
          throw new Error(errText || 'Failed to clear parent master metafield');
        }
      }
      
      console.log(`Successfully cleared parent master for ${childId}`);
      
      // Update local state
      setParentMasters(prev => ({
        ...prev,
        [childId]: ''
      }));
      
    } catch (err) {
      console.error('Error clearing parent master:', err);
      // We'll continue even if this fails, since removing from children array is the primary action
    }
  };
  
  /**
   * Adds a child variant to the master variant
   * Updates the children metafield and sets the parent-master relationship
   * 
   * @param {string} childId - The ID of the variant to add as a child
   */
  const handleAddChild = async (childId) => {
    try {
      // Check if this child is already in the children array
      if (children.includes(childId)) {
        setError('This variant is already a child of this master.');
        return;
      }
      
      // Find the variant in our available products list
      const productToAdd = availableProducts.find(p => p.id === childId);
      
      // Safety check: Don't allow adding if the variant is unavailable
      // This prevents adding variants that are already children of other masters
      if (productToAdd && productToAdd.unavailable) {
        setError(`Cannot add this variant. ${productToAdd.unavailableReason}`);
        return;
      }
      
      // Additional safety check: verify no parent master exists
      if (productToAdd && productToAdd.hasParentMaster && productToAdd.parentMasterId !== variantId) {
        setError(`Cannot add this variant as it already has a parent master assigned. A variant can only be a child of one master at a time.`);
        return;
      }
      
      // Create updated children array
      const updatedChildren = [...children, childId];
      
      // First, set the parent-master metafield on the child variant
      await setParentMasterMetafield(childId, variantId);
      
      // Then, update the children metafield on the master variant
      const res = await fetch('/api/update-variant-metafield', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId,
          namespace: 'projektstocksyncchildren',
          key: 'childrenkey',
          value: JSON.stringify(updatedChildren)
        })
      });
      
      if (!res.ok) {
        const errText = await res.text();
        try {
          const errData = JSON.parse(errText);
          throw new Error(errData.error || 'Failed to add child');
        } catch (jsonError) {
          throw new Error(errText || 'Failed to add child');
        }
      }
      
      // Update local state
      setChildren(updatedChildren);
      
      // Fetch details for the newly added child
      await refreshChildData(childId);
      
      setSuccess('Child added successfully');
      
      // Remove the added child from available products
      setAvailableProducts(prev => prev.filter(product => product.id !== childId));
      setTotalAvailableProducts(prev => prev - 1);
      
    } catch (err) {
      console.error('Error adding child:', err);
      setError(err.message);
    }
  };

  /**
   * Removes a child variant from the master variant
   * Updates the children metafield and clears the parent-master relationship
   * 
   * @param {string} childId - The ID of the child variant to remove
   */
  async function handleRemoveChild(childId) {
    try {
      setSuccess(null);
      setError(null);
      
      // Compute the updated children array
      const updatedChildren = children.filter((id) => id !== childId);
      
      // First, clear the parent-master metafield on the child variant
      await clearParentMasterMetafield(childId);
      
      // Then call the update-variant-metafield endpoint to update the children metafield
      const res = await fetch("/api/update-variant-metafield", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId,
          namespace: "projektstocksyncchildren",
          key: "childrenkey",
          value: JSON.stringify(updatedChildren),
        }),
      });
      
      if (!res.ok) {
        const errText = await res.text();
        try {
          const errData = JSON.parse(errText);
          throw new Error(errData.error || "Failed to update children metafield");
        } catch (jsonError) {
          throw new Error(errText || "Failed to update children metafield");
        }
      }
      
      // Update local children state
      setChildren(updatedChildren);
      setSuccess("Child removed successfully");
    } catch (err) {
      setError(err.message);
    }
  }

  /**
   * Updates the master ratio for a child variant
   * Sets the quantity management metafield value
   * 
   * @param {string} childId - The ID of the child variant
   * @param {number|string} newRatio - The new ratio value
   */
  async function handleUpdateMasterRatio(childId, newRatio) {
    try {
      setError(null);
      
      // Validate input - check if empty
      if (newRatio === "" || newRatio === null || newRatio === undefined) {
        throw new Error("Ratio cannot be empty");
      }
      
      // Validate input - check if it's a positive number
      const ratioNumber = parseInt(newRatio, 10);
      if (isNaN(ratioNumber) || ratioNumber < 1) {
        throw new Error("Ratio must be a positive integer");
      }
      
      // Update in state
      setMasterRatios(prev => ({
        ...prev,
        [childId]: ratioNumber
      }));
      
      // Detailed log for debugging
      console.log("=== START MASTER RATIO UPDATE ===");
      console.log("Sending API request to update ratio:", {
        variantId: childId,
        namespace: "projektstocksyncqtymanagement",
        key: "qtymanagement",
        value: String(ratioNumber),
        type: "number_integer"
      });
      
      // Call API to update the metafield with cache-busting
      const timestamp = new Date().getTime();
      const res = await fetch(`/api/update-variant-metafield?t=${timestamp}`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate" 
        },
        body: JSON.stringify({
          variantId: childId,
          namespace: "projektstocksyncqtymanagement",
          key: "qtymanagement",
          value: String(ratioNumber),
          type: "number_integer"
        }),
      });
      
      // Log the raw response for debugging
      const responseText = await res.text();
      console.log("API Response raw text:", responseText);
      
      // Try to parse the response as JSON
      let responseData = null;
      try {
        if (responseText) {
          responseData = JSON.parse(responseText);
          console.log("API Response parsed JSON:", responseData);
        }
      } catch (e) {
        console.log("Could not parse response as JSON");
      }
      
      if (!res.ok) {
        try {
          const errData = responseData || {};
          throw new Error(errData.error || "Failed to update master ratio");
        } catch (jsonError) {
          throw new Error(responseText || "Failed to update master ratio");
        }
      }
      
      // Show success message
      setSuccess(`Updated ratio for ${childrenDetails[childId]?.title || childId}`);
      
      console.log("API update completed successfully, refreshing data...");
      
      // Add a small delay before refreshing to allow the change to propagate
      setTimeout(async () => {
        // Refresh data to get the updated metafield value
        await refreshChildData(childId);
        console.log("=== END MASTER RATIO UPDATE ===");
      }, 500);
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        setSuccess(null);
      }, 3000);
      
    } catch (err) {
      console.error("Error updating ratio:", err);
      setError(err.message);
    }
  }

  /**
   * Fetch information about a parent master variant
   * 
   * @param {string} masterId - ID of the master variant
   */
  const fetchParentMasterInfo = async (masterId) => {
    try {
      console.log(`Fetching parent master info for ID: ${masterId}`);
      const res = await fetch(`/api/sync-product?variantId=${encodeURIComponent(masterId)}`);
      if (!res.ok) {
        throw new Error("Failed to fetch parent master info");
      }
      
      const data = await res.json();
      const masterVariant = data.product;
      
      if (masterVariant) {
        setParentMasterInfo({
          id: masterId,
          title: masterVariant.title || "Unknown",
          productTitle: masterVariant.product?.title || "Unknown Product",
          sku: masterVariant.sku || ""
        });
      }
    } catch (error) {
      console.error("Error fetching parent master info:", error);
    }
  };

  /**
   * Saves all changes to the variant
   * Updates inventory, master status, and children relationships
   * Shows a loading animation for 15 seconds to simulate background processing
   */
  async function handleSave() {
    try {
      console.log("Starting save operation...");
      setSuccess(null);
      setError(null);
      setLoading(true);
      
      // For child variants, no modifications are allowed
      if (isChild) {
        setSuccess("No changes needed for child variants");
        setShowSuccessAnimation(true);
        
        // Automatically hide the animation after 3 seconds
        setTimeout(() => {
          setShowSuccessAnimation(false);
          onClose(); // Close the modal after showing the message
        }, 3000);
        
        return;
      }
      
      // Log the values we're about to update
      console.log("Updating inventory to:", Number(inventory));
      console.log("Master status:", master);
      console.log("Children count:", children.length);
      
      // Update inventory via /api/update-inventory
      console.log("Updating inventory...");
      const invRes = await fetch("/api/update-inventory", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate" 
        },
        body: JSON.stringify({ 
          variantId, 
          newQuantity: Number(inventory) 
        }),
      });
      
      if (!invRes.ok) {
        const invText = await invRes.text();
        console.error("Inventory update error response:", invText);
        try {
          const invError = JSON.parse(invText);
          throw new Error(invError.error || "Failed to update inventory");
        } catch (jsonError) {
          throw new Error(invText || "Failed to update inventory");
        }
      }
      
      console.log("Inventory updated successfully");
      
      // Only update Master metafield if not a child variant
      if (!isChild) {
        console.log("Updating master status...");
        const masterRes = await fetch("/api/update-variant-metafield", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, no-store, must-revalidate" 
          },
          body: JSON.stringify({
            variantId,
            namespace: "projektstocksyncmaster",
            key: "master",
            value: master ? "true" : "false",
            type: "single_line_text_field"
          }),
        });
        
        if (!masterRes.ok) {
          const masterText = await masterRes.text();
          console.error("Master update error response:", masterText);
          throw new Error("Failed to update master status: " + masterText);
        }
        
        console.log("Master status updated successfully");
        
        // Update Children metafield directly 
        console.log("Updating children metafield...");
        const childrenRes = await fetch("/api/update-variant-metafield", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, no-store, must-revalidate" 
          },
          body: JSON.stringify({
            variantId,
            namespace: "projektstocksyncchildren",
            key: "childrenkey",
            value: JSON.stringify(children),
            type: "json"
          }),
        });
        
        if (!childrenRes.ok) {
          const childText = await childrenRes.text();
          console.error("Children update error response:", childText);
          throw new Error("Failed to update children: " + childText);
        }
        
        console.log("Children metafield updated successfully");
      }
      
      console.log("All API calls completed successfully");
      
      // Start the 10-second processing animation
      setSuccess("Variant Update Initiated");
      setShowSuccessAnimation(true);
      setIsProcessing(true);
      setProcessingProgress(0);
      setLoading(false);
      
      // Add a small delay to ensure all state updates are processed
      // This helps ensure the modal properly renders the updated data later
      setTimeout(() => {
        console.log("Setting initial processing state after delay");
      }, 100);
      
    } catch (err) {
      console.error("Save operation failed:", err);
      setError(err.message);
      setLoading(false);
    }
  }
  
  // Calculate total pages for pagination
  const totalPages = Math.ceil(totalAvailableProducts / childrenPerPage);

  // Render loading skeleton when data is being fetched
  if (loading) {
    return (
      <Modal 
        open 
        onClose={onClose} 
        title="Sync Variant Details" 
        size="large"
      >
        <Modal.Section>
          <BlockStack gap="4">
            <SkeletonDisplayText size="small" />
            <SkeletonBodyText lines={3} />
            <div style={{ height: "30px" }}></div>
            <SkeletonBodyText lines={2} />
          </BlockStack>
        </Modal.Section>
      </Modal>
    );
  }

  return (
    <>
      <style>{successAnimationStyles}</style>
      
      <Modal 
        open 
        onClose={onClose} 
        title={
          <InlineStack gap="2" align="center">
            <Text variant="headingLg" as="h2">
              {title || "Variant Details"}
            </Text>
            
            {!loading && !error && variantData && (
              <Tag color={master ? "blue" : isChild ? "yellow" : "base"}>
                {master ? "MASTER" : isChild ? "CHILD" : "STANDARD"}
              </Tag>
            )}
          </InlineStack>
        } 
        size="large"
      >
        <Modal.Section>
          {error && (
            <Banner status="critical" title="Error" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          )}
          
          {success && !showSuccessAnimation && (
            <Banner status="success" title="Success" onDismiss={() => setSuccess(null)}>
              {success}
            </Banner>
          )}
          
          {/* Enhanced Success animation overlay with processing state */}
          {showSuccessAnimation && (
            <div style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(255, 255, 255, 0.95)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              zIndex: 10,
              animation: "fadeIn 0.3s ease-in-out",
              padding: "20px"
            }}>
              {isProcessing ? (
                <>
                  {/* Processing State */}
                  <div style={{
                    marginBottom: "30px",
                    animation: "scaleIn 0.5s ease-out",
                    width: "150px",
                    height: "150px",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    position: "relative"
                  }}>
                    <div className="processing-spinner" style={{
                      width: "150px",
                      height: "150px",
                      border: "6px solid #f3f3f3",
                      borderTop: "6px solid #cced45",
                      borderRadius: "50%"
                    }}></div>
                    
                    <div style={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      transform: "translate(-50%, -50%)",
                      fontSize: "24px",
                      fontWeight: "bold",
                      color: "#cced54"
                    }}>
                      {processingProgress}%
                    </div>
                  </div>
                  
                  <div style={{
                    fontSize: "28px",
                    fontWeight: "bold",
                    color: "#202223",
                    animation: "fadeIn 0.5s ease-in-out 0.3s both",
                    marginBottom: "15px",
                    textAlign: "center"
                  }}>
                    Manual Updating Variant
                  </div>
                  
                  <div style={{
                    fontSize: "16px",
                    color: "#6d7175",
                    animation: "fadeIn 0.5s ease-in-out 0.5s both",
                    maxWidth: "400px",
                    textAlign: "center",
                    marginBottom: "25px"
                  }}>
                    Changes are being processed in the background. This will take approximately 15 seconds to complete.
                  </div>
                  
                  <div style={{ width: "100%", maxWidth: "400px" }}>
                    <ProgressBar progress={processingProgress} size="large" />
                  </div>
                </>
              ) : (
                <>
                  {/* Completed State */}
                  <div style={{
                    marginBottom: "30px",
                    animation: "scaleIn 0.5s ease-out",
                    width: "150px",
                    height: "150px",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    transform: "scale(2.0)"
                  }}>
                    <span style={{ width: "100%", height: "100%", color: "#cced54" }}>
                      <Icon 
                        source={CheckCircleIcon} 
                        tone="success" 
                        size="large" 
                      />
                    </span>
                  </div>
                  
                  <div style={{
                    fontSize: "28px",
                    fontWeight: "bold",
                    color: "#cced54",
                    animation: "fadeIn 0.5s ease-in-out 0.3s both",
                    marginTop: "30px"
                  }}>
                    Done
                  </div>
                </>
              )}
            </div>
          )}
          
          {!loading && !error && variantData && (
            <BlockStack gap="8">
              {/* Product Information */}
              <Card>
                <div className="Card-Section">
                  <BlockStack gap="2">
                    <Text variant="headingMd" as="h3">Product Information</Text>
                    
                    <Grid>
                      <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 4, xl: 4}}>
                        <Text variant="bodyMd" as="p" fontWeight="semibold">Product:</Text>
                        <Text variant="bodyMd" as="p">{variantData.product && variantData.product.title}</Text>
                      </Grid.Cell>
                      
                      <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 4, xl: 4}}>
                        <Text variant="bodyMd" as="p" fontWeight="semibold">Variant:</Text>
                        <Text variant="bodyMd" as="p">{title}</Text>
                      </Grid.Cell>
                      
                      <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 4, xl: 4}}>
                        <Text variant="bodyMd" as="p" fontWeight="semibold">SKU:</Text>
                        <Text variant="bodyMd" as="p">{variantData.sku || "N/A"}</Text>
                      </Grid.Cell>
                    </Grid>
              {/* Parent Master Information - Solo mostrar cuando es un child */}
              {isChild && parentMasterId && (
                <Card>
                  <div className="Card-Section">
                    <BlockStack gap="4">
                      <Text variant="headingMd" as="h3" color="critical">Child Variant Information</Text>
                      
                      <Banner
                        title="This variant is a child of another master"
                        status="info"
                      >
                        <p>This variant cannot be set as a master because it's already controlled by another master variant.</p>
                      </Banner>
                      
                      {parentMasterInfo ? (
                        <div style={{ 
                          border: '1px solid #dfe3e8', 
                          borderRadius: '4px', 
                          padding: '16px',
                          backgroundColor: '#f4f6f8' 
                        }}>
                          <Text variant="headingMd" as="h4">Parent Master Details</Text>
                          <Grid>
                            <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 6, xl: 6}}>
                              <Text variant="bodyMd" as="p" fontWeight="semibold">Master Product:</Text>
                              <Text variant="bodyMd" as="p">{parentMasterInfo.productTitle}</Text>
                            </Grid.Cell>
                            
                            <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 6, xl: 6}}>
                              <Text variant="bodyMd" as="p" fontWeight="semibold">Master Variant:</Text>
                              <Text variant="bodyMd" as="p">{parentMasterInfo.title}</Text>
                            </Grid.Cell>
                            
                            <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 6, xl: 6}}>
                              <Text variant="bodyMd" as="p" fontWeight="semibold">Master SKU:</Text>
                              <Text variant="bodyMd" as="p">{parentMasterInfo.sku}</Text>
                            </Grid.Cell>
                            
                            <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 6, xl: 6}}>
                              <Text variant="bodyMd" as="p" fontWeight="semibold">Master ID:</Text>
                              <Text variant="bodyMd" as="p">{parentMasterId.split('/').pop() || parentMasterId}</Text>
                            </Grid.Cell>
                          </Grid>
                        </div>
                      ) : (
                        <Text variant="bodyMd" as="p">Loading parent master information...</Text>
                      )}
                    </BlockStack>
                  </div>
                </Card>
              )}
                  </BlockStack>
                </div>
              </Card>
              
              {/* Inventory Section */}
              <Card>
                <div className="Card-Section">
                  <BlockStack gap="4">
                    <Text variant="headingMd" as="h3">Inventory Management</Text>
                    
                    {isChild ? (
                      <>
                        <Banner
                          title="Inventory managed by master variant"
                          status="info"
                        >
                          <p>This child variant's inventory is controlled by its master variant. The inventory cannot be modified directly.</p>
                        </Banner>
                        
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ flexGrow: 1 }}>
                            <TextField
                              label="Inventory Quantity"
                              type="number"
                              value={inventory}
                              disabled={true}
                              helpText="Inventory is managed by the master variant and cannot be edited here."
                              autoComplete="off"
                              min="0"
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <Grid>
                        <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 6, xl: 6}}>
                          <TextField
                            label="Inventory Quantity"
                            type="number"
                            value={inventory}
                            onChange={setInventory}
                            autoComplete="off"
                            min="0"
                          />
                        </Grid.Cell>
                        
                        <Grid.Cell columnSpan={{xs: 12, sm: 6, md: 6, lg: 6, xl: 6}}>
                          <Checkbox
                            label="Is Master Variant"
                            checked={master}
                            onChange={(value) => setMaster(value)}
                            helpText={
                              master 
                                ? "This variant can control inventory of child variants" 
                                : "Enable to make this variant a master"
                            }
                          />
                        </Grid.Cell>
                      </Grid>
                    )}
                  </BlockStack>
                </div>
              </Card>
              
              {/* Children Section - Only show if it's a master variant */}
              {master && !isChild && (
                <Card>
                <div className="Card-Header">
                  <InlineStack gap="4" align="space-between">
                    <Text variant="headingMd" as="h3">Child Variants</Text>
                    <Button onClick={handleOpenAddChildrenModal}>+ Add Children</Button>
                  </InlineStack>
                </div>
                
                <div className="Card-Section">
                    {children.length > 0 ? (
                      <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                        <table className="PolarisTEMPTable" style={{ width: "100%", borderCollapse: "collapse" }}>
                          <thead>
                            <tr>
                              <th style={{ 
                                borderBottom: "1px solid #ddd", 
                                padding: "12px 16px", 
                                width: "70px",
                                textAlign: "center" 
                              }}>
                                Image
                              </th>
                              <th style={{ 
                                borderBottom: "1px solid #ddd", 
                                padding: "12px 16px", 
                                textAlign: "left" 
                              }}>
                                Child Variant
                              </th>
                              <th style={{ 
                                borderBottom: "1px solid #ddd", 
                                padding: "12px 16px", 
                                textAlign: "center",
                                width: "100px"
                              }}>
                                Stock
                              </th>
                              <th style={{ 
                                borderBottom: "1px solid #ddd", 
                                padding: "12px 16px", 
                                textAlign: "center",
                                width: "150px"
                              }}>
                                Master Ratio
                              </th>
                              <th style={{ 
                                borderBottom: "1px solid #ddd", 
                                padding: "12px 16px", 
                                width: "70px",
                                textAlign: "center" 
                              }}>
                                Action
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {children.map((childId) => {
                              const childInfo = childrenDetails[childId] || {};
                              return (
                                <tr key={childId}>
                                  <td style={{ 
                                    padding: "12px 16px", 
                                    textAlign: "center",
                                    borderBottom: "1px solid #f1f1f1"
                                  }}>
                                    {childInfo.image ? (
                                      <img 
                                        src={childInfo.image} 
                                        alt={childInfo.title || "Product"} 
                                        style={{ 
                                          width: "50px", 
                                          height: "50px", 
                                          objectFit: "contain",
                                          border: "1px solid #ddd",
                                          borderRadius: "4px"
                                        }} 
                                        onError={(e) => {
                                          console.log("Image failed to load:", e.target.src);
                                          e.target.onerror = null; // Avoid infinite loops
                                          e.target.style.display = "none";
                                          e.target.parentNode.innerHTML = `
                                            <div 
                                              style="width: 50px; height: 50px; background-color: #f0f0f0; 
                                                    border: 1px solid #ddd; border-radius: 4px; display: flex; 
                                                    align-items: center; justify-content: center;"
                                            >
                                              <span style="color: #999; font-size: 10px;">No image</span>
                                            </div>
                                          `;
                                        }}
                                      />
                                    ) : (
                                      <div 
                                        style={{ 
                                          width: "50px", 
                                          height: "50px", 
                                          backgroundColor: "#f0f0f0",
                                          border: "1px solid #ddd",
                                          borderRadius: "4px",
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "center"
                                        }}
                                      >
                                        <span style={{ color: "#999", fontSize: "10px" }}>No image</span>
                                      </div>
                                    )}
                                  </td>
                                  <td style={{ 
                                    padding: "12px 16px",
                                    borderBottom: "1px solid #f1f1f1"
                                  }}>
                                    <Text variant="bodyMd" as="p" fontWeight="semibold">
                                      {childInfo.title || "Unknown"}
                                    </Text>
                                    <Text variant="bodySm" as="p" color="subdued">
                                      ID: {childId.split('/').pop() || childId}
                                    </Text>
                                    {childInfo.sku && (
                                      <Text variant="bodySm" as="p" color="subdued">
                                        SKU: {childInfo.sku}
                                      </Text>
                                    )}
                                  </td>
                                  <td style={{ 
                                    padding: "12px 16px", 
                                    textAlign: "center",
                                    borderBottom: "1px solid #f1f1f1"
                                  }}>
                                    <div style={{ 
                                      display: "inline-block",
                                      padding: "2px 8px", 
                                      borderRadius: "12px", 
                                      backgroundColor: (childInfo.inventory && childInfo.inventory > 0) ? "#e3f1df" : "#fbeae5",
                                      color: (childInfo.inventory && childInfo.inventory > 0) ? "#108043" : "#de3618",
                                      fontWeight: "500"
                                    }}>
                                      {childInfo.inventory !== undefined ? childInfo.inventory : "?"}
                                    </div>
                                  </td>
                                  <td style={{ 
                                    padding: "12px 16px", 
                                    textAlign: "center",
                                    borderBottom: "1px solid #f1f1f1"
                                  }}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                                      <TextField
                                        label=""
                                        labelHidden={true}
                                        type="number"
                                        value={masterRatios[childId] !== undefined ? String(masterRatios[childId]) : ""}
                                        placeholder="Value"
                                        onChange={(value) => {
                                          // If value is empty, store as empty string
                                          if (value === "") {
                                            setMasterRatios(prev => ({
                                              ...prev,
                                              [childId]: ""
                                            }));
                                          } else {
                                            // If there's a value, try to convert to integer
                                            const parsedValue = parseInt(value, 10);
                                            setMasterRatios(prev => ({
                                              ...prev,
                                              [childId]: isNaN(parsedValue) ? "" : parsedValue
                                            }));
                                          }
                                        }}
                                        onBlur={() => {
                                          // Only update if there is a value and it's valid
                                          const currentRatio = masterRatios[childId];
                                          if (currentRatio !== "" && currentRatio !== undefined) {
                                            console.log("Updating ratio for child", childId, "to", currentRatio);
                                            handleUpdateMasterRatio(childId, currentRatio);
                                          }
                                        }}
                                        min="1"
                                        autoComplete="off"
                                      />
                                    </div>
                                  </td>
                                  <td style={{ 
                                    padding: "12px 16px", 
                                    textAlign: "center",
                                    borderBottom: "1px solid #f1f1f1"
                                  }}>
                                    <Button
                                      icon={
                                        <Icon
                                          source={DeleteIcon}
                                          tone="critical"
                                        />
                                      }
                                      onClick={() => handleRemoveChild(childId)}
                                      accessibilityLabel={`Remove child ${childInfo.title || childId}`}
                                      variant="plain"
                                      size="large"
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <EmptyState
                        heading="No child variants"
                        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                      >
                        <p>Click the "Add Children" button to add child variants to this master variant.</p>
                      </EmptyState>
                    )}
                </div>
              </Card>
              )}
            </BlockStack>
          )}
        </Modal.Section>
        
        <Modal.Section>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <Button onClick={onClose}>Cancel</Button>
            {!isChild && (
              <Button primary onClick={handleSave} disabled={loading || isProcessing}>
                Save Changes
              </Button>
            )}
            {isChild && (
              <Button onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </Modal.Section>
      </Modal>
    
      {/* Add Children Modal with Pagination */}
      {isAddChildrenModalOpen && (
        <Modal
          open={true}
          onClose={handleCloseAddChildrenModal}
          title="Add Child Variants"
          size="large"
        >
          <Modal.Section>
            <BlockStack gap="4">
              <Text variant="bodyMd" as="p">
                Select variants to add as children to this master variant. Child variants will be linked to this master for inventory synchronization.
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
              
              {loadingProducts ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                  <Spinner accessibilityLabel="Loading products" size="large" />
                </div>
              ) : (
                <Card>
                  <div style={{ maxHeight: '500px', overflowY: 'auto' }}>
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
                              {product.image ? (
                                <img 
                                  src={product.image} 
                                  alt={product.title || 'Product'} 
                                  style={{ 
                                    width: '50px', 
                                    height: '50px', 
                                    objectFit: 'contain',
                                    border: '1px solid #ddd',
                                    borderRadius: '4px'
                                  }} 
                                  onError={(e) => {
                                    e.target.onerror = null;
                                    e.target.style.display = 'none';
                                    e.target.parentNode.innerHTML = `
                                      <div 
                                        style="width: 50px; height: 50px; background-color: #f0f0f0; 
                                              border: 1px solid #ddd; border-radius: 4px; display: flex; 
                                              align-items: center; justify-content: center;"
                                      >
                                        <span style="color: #999; font-size: 10px;">No image</span>
                                      </div>
                                    `;
                                  }}
                                />
                              ) : (
                                <div 
                                  style={{ 
                                    width: '50px', 
                                    height: '50px', 
                                    backgroundColor: '#f0f0f0',
                                    border: '1px solid #ddd',
                                    borderRadius: '4px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                  }}
                                >
                                  <span style={{ color: '#999', fontSize: '10px' }}>No image</span>
                                </div>
                              )}
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
                              {product.unavailable || product.hasParentMaster || (product.rawParentMasterValue && product.rawParentMasterValue !== "[]" && product.rawParentMasterValue !== "null") ? (
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
                                  disabled={
                                    product.unavailable || 
                                    product.hasParentMaster || 
                                    (product.rawParentMasterValue && 
                                     product.rawParentMasterValue !== "[]" && 
                                     product.rawParentMasterValue !== "null")
                                  }
                                >
                                  Add
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                        
                        {availableProducts.length === 0 && (
                          <tr>
                            <td colSpan="5" style={{ padding: '32px 16px', textAlign: 'center' }}>
                              <EmptyState
                                heading={
                                  childSearchQuery 
                                    ? 'No matching variants found' 
                                    : 'No available variants found'
                                }
                                image=""
                              >
                                <p>
                                  {childSearchQuery 
                                    ? 'Try a different search term or check for variants that are not already assigned to other masters.' 
                                    : 'There are no available variants to add as children. Create more variants or free existing variants from other masters.'}
                                </p>
                              </EmptyState>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
              
              {/* Pagination controls */}
              {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
                  <Pagination
                    hasPrevious={childrenPage > 1}
                    onPrevious={() => handleChildrenPageChange(childrenPage - 1)}
                    hasNext={childrenPage < totalPages}
                    onNext={() => handleChildrenPageChange(childrenPage + 1)}
                    label={`${(childrenPage - 1) * childrenPerPage + 1}-${Math.min(childrenPage * childrenPerPage, totalAvailableProducts)} of ${totalAvailableProducts} variants`}
                  />
                </div>
              )}
            </BlockStack>
          </Modal.Section>
          
          <Modal.Section>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <Button onClick={handleCloseAddChildrenModal}>Done</Button>
            </div>
          </Modal.Section>
        </Modal>
      )}
    </>
  );
}