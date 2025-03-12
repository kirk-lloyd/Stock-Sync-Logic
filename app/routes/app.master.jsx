import React, { useEffect } from "react";
import { Page, Frame, Banner, Box, Button } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { Helmet } from "react-helmet";
import { useLoaderData, useRevalidator } from "@remix-run/react";
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
 * Loader function that fetches product data with a focus on master variants
 */
export const loader = async ({ request }) => {
  console.log("Master View Loader: Authenticating and preparing Bulk Operation…");
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session?.shop;
  if (!shopDomain) {
    return json({ error: "No shop found in session" }, { status: 401 });
  }
  
  // Get shop subscription details
  let shopSub = await prisma.shopSubscription.findUnique({ where: { shop: shopDomain } });
  let locked = !shopSub || shopSub.status !== "ACTIVE";
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
};

/**
 * Main component for Master Products view
 * This displays only products that have at least one variant marked as master
 */
export default function MasterProductsView() {
  // Prevents server-side rendering issues
  if (typeof window === "undefined") return null;
  
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

  // Add automatic refresh for CREATED and RUNNING states
  useEffect(() => {
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
  }, [bulkInProgress, bulkStatus, revalidator]);

  // Function to initiate product sync
  async function handleSyncProducts() {
    try {
      const response = await fetch("/api/start-bulk-operation", { 
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      
      if (!response.ok) {
        throw new Error("Failed to start bulk operation");
      }
      
      console.log("Product sync started. This may take a few moments to complete.");
      
      // Refresh page data after a short delay
      setTimeout(() => {
        revalidator.revalidate();
      }, 2000);
    } catch (error) {
      console.error("Failed to sync products:", error);
    }
  }

  // Content for loading state during bulk operation
  if (bulkInProgress) {
    return (
      <Frame>
        <Page>
          <Banner title="Importing Products" status="info">
            <p>
              We're currently fetching your product catalogue in bulk. The status is <b>{bulkStatus}</b>.<br />
              This page will auto-refresh until the data is ready.
            </p>
          </Banner>
          
          {/* Manual refresh button for better user experience */}
          <Box padding="4" style={{ display: "flex", justifyContent: "center" }}>
            <Button onClick={() => revalidator.revalidate()}>
              Check Status Now
            </Button>
          </Box>
        </Page>
      </Frame>
    );
  }

  return (
    <Frame>
      <Page>
        <Helmet>
          <script src="https://cdn.botpress.cloud/webchat/v2.3/inject.js"></script>
          <script src="https://files.bpcontent.cloud/2025/02/24/22/20250224223007-YAA5E131.js"></script>
        </Helmet>
        <TitleBar title="Master Products" />
        
        {/* Top-right Sync Products button */}
        <Box padding="4" style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button primary onClick={handleSyncProducts}>
            Sync Products
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
        
        {/* Reusable ProductsTable component with master filter applied */}
        <ProductsTable 
          initialProducts={products}
          locked={locked}
          showMasterVariantsOnly={true} // This flag indicates we're in the master view
        />
      </Page>
    </Frame>
  );
}