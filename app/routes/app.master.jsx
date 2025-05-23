import React, { useEffect, useState } from "react";
import { Page, Frame, Banner, Box, Button, Card, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ProductsTable } from "../components/ProductsTable";
import { LoadingOverlay } from "../components/LoadingOverlay.jsx";
import { BulkLoadingOverlay } from "../components/BulkLoadingOverlay.jsx";
import { TablePreloader } from "../components/TablePreloader.jsx";
import {
  startBulkOperation,
  checkBulkOperationStatus,
  fetchBulkResults,
  rebuildNestedProducts,
  processProductData
} from "../utils/product-utils";

/**
 * Loader function that fetches product data with a focus on master variants
 */
export const loader = async ({ request }) => {
  try {
    console.log("Master View Loader: Authenticating and preparing Bulk Operation…");
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
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      if (new Date(currentOp.completedAt) < fifteenMinutesAgo) {
        console.log("Bulk result is old (older than 15 minutes). Starting a new bulk operation.");
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
    
    // Process data as in the main view
    const reassembledProducts = rebuildNestedProducts(allNodes);
    console.log(`Reassembled into ${reassembledProducts.length} top-level products.`);
    
    const productsParsed = processProductData(reassembledProducts);
    
    // Filter products to only include those with master variants
    const masterProducts = productsParsed.filter(product => {
      return product.variants.edges.some(edge => edge.node.isMaster);
    });
    
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
      products: masterProducts, // Only return products with master variants
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
  } catch (error) {
    console.error("Critical error in master products loader:", error);
    return json({
      error: "An unexpected error occurred whilst loading your products.",
      products: [],
      bulkInProgress: false
    });
  }
};

/**
 * Main component for Master Products view
 * This displays only products that have at least one variant marked as master
 */
export default function MasterProductsView() {
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
    error,
  } = useLoaderData();
  
  const revalidator = useRevalidator();
  const [syncLoading, setSyncLoading] = useState(false);
  const [isTableReady, setIsTableReady] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const [showGettingStartedCard, setShowGettingStartedCard] = useState(true);

  // Safely handle client-side rendering
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

  // Add automatic refresh for CREATED and RUNNING states
  useEffect(() => {
    if (!isClient) return;
    
    let timer;
    if (bulkInProgress && ["CREATED", "RUNNING"].includes(bulkStatus)) {
      // Check more frequently (every 5 seconds) when the operation is in progress
      timer = setTimeout(() => {
        console.log("Auto-refreshing to check bulk operation status...");
        revalidator.revalidate();
      }, 5000);
    }
    
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [bulkInProgress, bulkStatus, revalidator, isClient]);

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
        // Close the modal after 30 seconds
        setSyncLoading(false);
        
        // Use revalidator instead of hard reload
        revalidator.revalidate();
      }, 30000);
      
    } catch (error) {
      console.error("Failed to sync products:", error);
      setSyncLoading(false);
    }
  }

  // Handle error state
  if (error) {
    return (
      <Frame>
        <Page>
          <TitleBar title="Master Products" />
          <Banner status="critical" title="Error Loading Products">
            <p>{error}</p>
            <Button onClick={() => revalidator.revalidate()} primary>Try Again</Button>
          </Banner>
        </Page>
      </Frame>
    );
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
        <TitleBar title="Master Products" />
        
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
        
        
        <Card sectioned style={{ padding: '20px', marginBottom: '20px' }}>
          <Text variant="headingMd">Can't see the master products?</Text>
          <Text>
            To view your newly assigned master products, please click the "Update Products" button above. 
            This will refresh the data and ensure all recent changes are displayed in the table below. 
            Alternatively, the data will update automatically after 10 minutes.
          </Text>
        </Card>

        {/* New Card that appears when no products are found */}
        {products.length === 0 && !bulkInProgress && (
          <Card sectioned style={{ padding: '20px', marginBottom: '20px' }}>
            <Text variant="headingMd">No Master Products Found</Text>
            <Text>
              We couldn't find any products with master variants. If you've recently assigned master variants to your products,
              try clicking the "Update Products" button above to refresh the data. If you haven't assigned any master variants yet,
              please go to the Products page to assign them.
            </Text>
            <Button url="/app/products/">
              Manage all products 📦
            </Button>
          </Card>
        )}

        {/* Control rendering to prevent layout jumps */}
        <div style={{ position: 'relative', marginTop: '20px' }}>
          {!isTableReady && <TablePreloader />}
          
          <div style={{ visibility: isTableReady ? 'visible' : 'hidden' }}>
            {/* Reusable ProductsTable component with master filter applied */}
            {isClient && (
              <ProductsTable 
                initialProducts={products}
                locked={locked}
                showMasterVariantsOnly={true} // This flag indicates we're in the master view
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

// Error boundary component to handle navigation errors
export function ErrorBoundary() {
  const error = useRouteError();
  
  return (
    <Frame>
      <Page>
        <TitleBar title="Master Products" />
        <Card>
          <Box padding="4">
            <Text variant="headingLg" as="h2">Strewth! An error occurred</Text>
            <Text variant="bodyMd" as="p">
              We've encountered a bit of a hiccup whilst loading your master products. 
              Please refresh the page to have another go.
            </Text>
            <div style={{ marginTop: "20px" }}>
              <Button onClick={() => window.location.reload()} primary>Refresh Page</Button>
            </div>
          </Box>
        </Card>
      </Page>
    </Frame>
  );
}