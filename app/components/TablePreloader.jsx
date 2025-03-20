import React from "react";
import { SkeletonBodyText, SkeletonDisplayText, Card, Box } from "@shopify/polaris";

/**
 * TablePreloader Component
 * 
 * A skeleton loader for the table that prevents layout jumps during initial loading
 */
export function TablePreloader() {
  return (
    <Card padding="0">
      {/* Search bar placeholder */}
      <Box paddingBlock="300" paddingInline="300" style={{ marginBottom: "10px" }}>
        <SkeletonDisplayText size="small" />
      </Box>
      
      {/* Table header placeholder */}
      <div 
        style={{ 
          borderBottom: "1px solid #e1e3e5",
          display: "flex",
          height: "44px",
          paddingLeft: "16px",
          paddingRight: "16px",
          alignItems: "center"
        }}
      >
        <SkeletonDisplayText size="small" />
      </div>
      
      {/* Table rows */}
      {Array.from({ length: 5 }).map((_, index) => (
        <div 
          key={index}
          style={{ 
            padding: "16px",
            borderBottom: "1px solid #f1f2f3",
            display: "flex",
            alignItems: "center",
            gap: "16px"
          }}
        >
          {/* Thumbnail placeholder */}
          <div 
            style={{ 
              width: "60px", 
              height: "60px", 
              backgroundColor: "#f1f2f3",
              borderRadius: "3px" 
            }}
          />
          <div style={{ flex: 1 }}>
            <SkeletonBodyText lines={2} />
          </div>
          <div style={{ width: "80px" }}>
            <SkeletonDisplayText size="small" />
          </div>
          <div style={{ width: "120px" }}>
            <SkeletonDisplayText size="small" />
          </div>
        </div>
      ))}
      
      {/* Pagination placeholder */}
      <div 
        style={{ 
          display: "flex", 
          justifyContent: "center", 
          padding: "16px", 
          borderTop: "1px solid #e1e3e5" 
        }}
      >
        <SkeletonDisplayText size="small" />
      </div>
    </Card>
  );
}