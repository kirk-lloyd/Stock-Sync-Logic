import {
  Box,
  Card,
  Layout,
  Link,
  List,
  Page,
  Text,
  BlockStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";

// Create a component for the iframe
const YouTubeEmbed = ({ embedId }) => {
  const [isMounted, setIsMounted] = useState(false);
  
  useEffect(() => {
    setIsMounted(true);
  }, []);
  
  // During server rendering, show a placeholder
  if (!isMounted) {
    return (
      <div style={{ 
        width: '560px', 
        height: '315px', 
        backgroundColor: '#f1f1f1',
        margin: '0 auto',
        borderRadius: '8px'
      }}></div>
    );
  }
  
  // On the client, show the real iframe
  return (
    <iframe
      width="560"
      height="315"
      src={`https://www.youtube.com/embed/${embedId}`}
      title="YouTube video player"
      frameBorder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
    ></iframe>
  );
};

// AdditionalPage renders the help page for Projekt: Stock Control Master, providing detailed documentation.
export default function AdditionalPage() {
  const [isClient, setIsClient] = useState(false);
  
  useEffect(() => {
    setIsClient(true);
  }, []);

  return (
    <Page>
      <TitleBar title="Help" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Card 1: Introduction to Projekt: Stock Control Master */}
            <Card>
              <BlockStack gap="400">
                <Text as="h1" variant="headingLg">
                  What is Projekt: Stock Control Master?
                </Text>
                <Text as="p" variant="bodyMd">
                  Projekt: Stock Control Master is a user-friendly inventory synchronisation tool
                  designed to help you avoid errors in stock management.
                  It automatically updates your inventory across products,
                  ensuring your stock levels are always accurate.
                </Text>
              </BlockStack>
            </Card>
            {/* Card 2: How to use Projekt: Stock Control Master */}
            <Card>
              <BlockStack gap="400">
                <Text as="h1" variant="headingLg">
                  How to use Projekt: Stock Control Master 
                </Text>
                <Text as="p" variant="bodyMd">
                  Using Projekt: Stock Control Master is straightforward and helps prevent mistakes
                  in inventory management. To set it up, follow these steps:
                  <br />
                  <br /><strong></strong>
                  1. Choose a primary product (Master) that defines your actual
                  stock.
                  <br />
                  2. Assign secondary products (Children) that will share the
                  Master's inventory.
                  <br />
                  3. Set up custom rules. If a Child product represents a pack or
                  a fraction of the Master, configure a "Master Ratio" to adjust
                  the stock accordingly.
                  <br />
                  4. Save your changes and let Projekt: Stock Control Master do the rest.
                </Text>
                {/* YouTube video with client-side rendering */}
                {isClient && (
                  <div style={{ display: "flex", justifyContent: "center", margin: "1rem 0" }}>
                    <YouTubeEmbed embedId="SzNUaNqiHB8" />
                  </div>
                )}
              </BlockStack>
            </Card>
            {/* Card 3: What is a Master */}
            <Card>
              <BlockStack gap="400">
                <Text as="h1" variant="headingLg">
                  What is a Master
                </Text>
                <Text as="p" variant="bodyMd">
                  A Master is the primary product that defines the synchronised
                  inventory. It acts as the base product on which other products
                  depend. For example, if you sell an individual water bottle and
                  also a pack of six, the actual stock is determined by the
                  individual bottle – making it the Master, with the pack being a
                  linked Child.
                </Text>
              </BlockStack>
            </Card>
            {/* Card 4: What is a Child */}
            <Card>
              <BlockStack gap="400">
                <Text as="h1" variant="headingLg">
                  What is a Child
                </Text>
                <Text as="p" variant="bodyMd">
                  A Child is a product that shares its inventory with the Master.
                  Every time a Child is sold, the Master's stock is automatically
                  adjusted. This is ideal for items sold both individually and in
                  packs, or for variations such as different colours or sizes of the
                  same product.
                </Text>
              </BlockStack>
            </Card>
            {/* Card 5: How to assign a Child to a Master */}
            <Card>
              <BlockStack gap="400">
                <Text as="h1" variant="headingLg">
                  How to assign a Child to a Master
                </Text>
                <Text as="p" variant="bodyMd">
                  Assigning a Child to a Master in Projekt: Stock Control Master is simple within your
                  Shopify store:
                  <br />
                  <br />
                  1. Open Projekt: Stock Control Master in your Shopify store.
                  <br />
                  2. Select the product that will serve as the Master.
                  <br />
                  3. Add the Child products that will share the Master's inventory.
                  <br />
                  4. Configure the "Master Ratio" if the Child represents a pack or
                  fraction of the Master.
                  <br />
                  5. Save your changes – any stock
                  change in the Master will automatically update the Child
                  products.
                </Text>
              </BlockStack>
            </Card>
            {/* Card 6: What is a Master Ratio */}
            <Card>
              <BlockStack gap="400">
                <Text as="h1" variant="headingLg">
                  What is a Master Ratio
                </Text>
                <Text as="p" variant="bodyMd">
                  The Master Ratio defines the relationship between the Master and
                  its Children. It specifies how the inventory should be adjusted
                  when a synchronised product is sold. For example:
                  <br />
                  <br />
                  - 1 ratio means one unit is deducted from the Master for each
                  Child sold.
                  <br />
                  - 2 ratio means two units are deducted when a Child
                  representing a pack of two is sold.
                  <br />
                  <br />
                  This ensures accurate stock management across various product
                  presentations without the need for manual adjustments.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// Code component renders inline code snippets with appropriate styling.
function Code({ children }) {
  return (
    <Box
      as="span"
      padding="025"
      paddingInlineStart="100"
      paddingInlineEnd="100"
      background="bg-surface-active"
      borderWidth="025"
      borderColor="border"
      borderRadius="100"
    >
      <code>{children}</code>
    </Box>
  );
}