import React, { useState, useEffect } from "react";
import { Page, Frame, Banner, Box, Button } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { LoadingOverlay } from "../components/LoadingOverlay.jsx";
import { BulkLoadingOverlay } from "../components/BulkLoadingOverlay.jsx";
import { TablePreloader } from "../components/TablePreloader.jsx";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ProductsTable } from "../components/ProductsTable";
import {
  startBulkOperation,
  checkBulkOperationStatus,
  fetchBulkResults,
  rebuildNestedProducts,
  processProductData
} from "../utils/product-utils";

/**
 * Loader function that fetches all product data from Shopify
 */
export const loader = async ({ request }) => {
  console.log("Products View Loader: Authenticating and preparing Bulk Operation…");
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session?.shop;
  if (!shopDomain) {
    return json({ error: "No shop found in session" }, { status: 401 });
  }
  
  // Get shop subscription details
  let shopSub = await prisma.shopSubscription.findUnique({ where: { shop: shopDomain } });
  let locked = !shopSub || (shopSub.status !== "ACTIVE" && shopSub.status !== "PENDING_CANCELLATION");
  let plan = shopSub?.plan || "UNKNOWN";
  let variantsLimit = shopSub?.variantsLimit ?? 0;
  let status = shopSub?.status || "INACTIVE";

  // Check and process bulk operation
  let currentOp = await checkBulkOperationStatus(admin);
  if (!currentOp) {
    console.log("No valid Bulk Operation. Starting one…");
    await startBulkOperation(admin);
    return json({
      products: [],
      locked,
      plan,
      status,
      variantsLimit,
      totalSyncedVariants: 0,
      overLimit: false,
      mustRemove: 0,
      bulkStatus: "CREATED",
      bulkInProgress: true,
    });
  } else if (["CREATED", "RUNNING"].includes(currentOp.status)) {
    console.log("Bulk operation in progress – returning loading state…");
    return json({
      products: [],
      locked,
      plan,
      status,
      variantsLimit,
      totalSyncedVariants: 0,
      overLimit: false,
      mustRemove: 0,
      bulkStatus: currentOp.status,
      bulkInProgress: true,
    });
  } else if (currentOp.status === "COMPLETED") {
    const twoMinutesAgo = new Date(Date.now() - 900000);
    if (new Date(currentOp.completedAt) < twoMinutesAgo) {
      console.log("Bulk result is old (older than 2 minutes). Starting a new bulk operation.");
      await startBulkOperation(admin);
      return json({
        products: [],
        locked,
        plan,
        status,
        variantsLimit,
        totalSyncedVariants: 0,
        overLimit: false,
        mustRemove: 0,
        bulkStatus: "CREATED",
        bulkInProgress: true,
      });
    }
    console.log("Bulk operation COMPLETED. Fetching data…");
  } else if (["CANCELED", "FAILED"].includes(currentOp.status)) {
    console.log("Bulk operation cancelled/failed – starting new one…");
    await startBulkOperation(admin);
    return json({
      products: [],
      locked,
      plan,
      status,
      variantsLimit,
      totalSyncedVariants: 0,
      overLimit: false,
      mustRemove: 0,
      bulkStatus: currentOp.status,
      bulkInProgress: true,
    });
  }

  // Fetch and process bulk operation results
  if (!currentOp.url) {
    console.error("Operation COMPLETED but no URL found.");
    return json({
      products: [],
      error: "Bulk operation completed but no file URL was returned.",
      locked,
      plan,
      variantsLimit,
    });
  }
  
  let allNodes = [];
  try {
    console.log("Fetching from URL:", currentOp.url);
    allNodes = await fetchBulkResults(currentOp.url);
  } catch (error) {
    console.error("Error fetching bulk results:", error);
    return json({
      products: [],
      error: "Failed to download bulk results.",
      locked,
      plan,
      variantsLimit,
    });
  }
  
  // Process the data
  const reassembledProducts = rebuildNestedProducts(allNodes);
  console.log(`Reassembled into ${reassembledProducts.length} top-level products.`);
  
  const productsParsed = processProductData(reassembledProducts);
  
  // Calculate totals and limits
  let totalSyncedVariants = 0;
  productsParsed.forEach((p) => {
    p.variants.edges.forEach((ve) => {
      const v = ve.node;
      const isChild = v.childVariantIds?.length > 0;
      if (v.isMaster || isChild) {
        totalSyncedVariants += 1;
      }
    });
  });
  
  let overLimit = false;
  let mustRemove = 0;
  if (!locked && variantsLimit > 0 && totalSyncedVariants > variantsLimit) {
    overLimit = true;
    mustRemove = totalSyncedVariants - variantsLimit;
  }
  
  return json({
    products: productsParsed,
    locked,
    plan,
    status,
    variantsLimit,
    totalSyncedVariants,
    overLimit,
    mustRemove,
    bulkStatus: "COMPLETED",
    bulkInProgress: false,
  });
};

/**
 * Main component for All Products view
 * This displays all products and their variants
 */
export default function ProductsView() {
  // Extract data from loader
  const {
    products,
    locked,
    plan,
    status,
    variantsLimit,
    totalSyncedVariants,
    overLimit,
    mustRemove,
    bulkInProgress,
    bulkStatus,
  } = useLoaderData();
  
  const revalidator = useRevalidator();
  
  // State for sync loading modal
  const [syncLoading, setSyncLoading] = useState(false);
  
  // State to control component rendering
  const [isTableReady, setIsTableReady] = useState(false);
  
  // State for client-side rendering check
  const [isClient, setIsClient] = useState(false);

  // Check if we're on the client
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Control the rendering of components to prevent layout jumps
  useEffect(() => {
    if (!isClient) return;
    
    // Use a short timeout to ensure all resources are loaded
    const timer = setTimeout(() => {
      setIsTableReady(true);
    }, 300);
    
    return () => clearTimeout(timer);
  }, [isClient]);

  // Function to initiate product sync
  async function handleSyncProducts() {
    try {
      setSyncLoading(true);
      
      const response = await fetch("/api/start-bulk-operation", { 
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      
      if (!response.ok) {
        throw new Error("Failed to start bulk operation");
      }
      
      // Wait 30 seconds to show the loading message
      setTimeout(() => {
        // Hide the loading overlay after 30 seconds
        setSyncLoading(false);
        
        // Use revalidator instead of hard reload
        revalidator.revalidate();
      }, 30000);
      
    } catch (error) {
      console.error("Failed to sync products:", error);
      setSyncLoading(false);
    }
  }

  // Content for loading state during bulk operation
  if (bulkInProgress) {
    return (
      <Frame>
        <Page>
          {isClient && (
            <BulkLoadingOverlay 
              active={true}
              status={bulkStatus}
              onRefresh={() => revalidator.revalidate()}
            />
          )}
        </Page>
      </Frame>
    );
  }

  return (
    <Frame>
      <Page>
        <TitleBar title="All Products" />
        
        {/* Top-right Sync Products button */}
        <Box padding="4" style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button primary onClick={handleSyncProducts}>
            Update Products
          </Button>
        </Box>
        
        {/* Subscription and limit warnings */}
        {locked && (
          <Banner status="critical" title="No Active Subscription">
            <p>
              Your current plan status is <strong>{status}</strong>. Please choose or upgrade your plan.
            </p>
            <Button url="/app/settings" primary>
              Choose a Plan
            </Button>
          </Banner>
        )}
        
        {overLimit && (
          <Banner status="critical" title="Variant Limit Exceeded">
            <p>
              You have {totalSyncedVariants} synced variants, but your plan allows {variantsLimit}.
              <br />
              Remove at least {mustRemove} Master/Child assignments or upgrade your plan.
            </p>
          </Banner>
        )}
        
        {/* Control rendering to prevent layout jumps */}
        <div style={{ position: 'relative' }}>
          {!isTableReady && <TablePreloader />}
          
          <div style={{ visibility: isTableReady ? 'visible' : 'hidden' }}>
            {/* Only render the ProductsTable component on the client side */}
            {isClient && (
              <ProductsTable 
                initialProducts={products}
                locked={locked}
                showMasterVariantsOnly={false} // Show all variants
              />
            )}
          </div>
        </div>
      </Page>
      
      {/* Loading Overlay */}
      {isClient && (
        <LoadingOverlay 
          active={syncLoading} 
          message="We're downloading all products from your store. The processing time depends on the number of products you have."
        />
      )}
    </Frame>
  );
}