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
import { Helmet } from "react-helmet";

// AdditionalPage renders the help page for Synclogic, providing detailed documentation.
export default function AdditionalPage() {
  return (
    <Page>
      <Helmet>
        {/* External scripts for webchat and other integrations */}
        <script src="https://cdn.botpress.cloud/webchat/v2.3/inject.js"></script>
        <script src="https://files.bpcontent.cloud/2025/02/24/22/20250224223007-YAA5E131.js"></script>
      </Helmet>
        <TitleBar title="Help">
          {/*<button
            variant="primary"
            onClick={() => window.location.href = '/app/products/'}
          >
            Manage all products 📦
          </button>
          <button
            onClick={() => window.location.href = '/master/'}
          >
            Master List 👑
          </button>*/}
        </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Card 1: Introduction to Synclogic */}
            <Card>
              <BlockStack gap="400">
                <Text as="H1" variant="headingLg">
                  What is Synclogic
                </Text>
                <Text as="p" variant="bodyMd">
                  Synclogic is a user-friendly inventory synchronisation tool
                  designed to help you avoid errors in stock management.
                  It automatically updates your inventory across products,
                  ensuring your stock levels are always accurate.
                </Text>
              </BlockStack>
            </Card>
            {/* Card 2: How to use Synclogic */}
            <Card>
              <BlockStack gap="400">
                <Text as="H1" variant="headingLg">
                  How to use Synclogic
                </Text>
                <Text as="p" variant="bodyMd">
                  Using Synclogic is straightforward and helps prevent mistakes
                  in inventory management. To set it up, follow these steps:
                  <br />
                  <br /><strong></strong>
                  1. Choose a primary product (Master) that defines your actual
                  stock.
                  <br />
                  2. Assign secondary products (Children) that will share the
                  Master’s inventory.
                  <br />
                  3. Set up custom rules. If a Child product represents a pack or
                  a fraction of the Master, configure a “Master Ratio” to adjust
                  the stock accordingly.
                  <br />
                  4. Save your changes and let Synclogic do the rest.
                </Text>
                {/* 3. Embedded YouTube video between the welcome text and the next section */}
                <div style={{ display: "flex", justifyContent: "center", margin: "1rem 0" }}>
                  <iframe
                    width="560"
                    height="315"
                    src="https://www.youtube.com/embed/y91Pyv6xfOQ"
                    title="YouTube video player"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  ></iframe>
                </div>
              </BlockStack>
            </Card>
            {/* Card 3: What is a Master */}
            <Card>
              <BlockStack gap="400">
                <Text as="H1" variant="headingLg">
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
                {/* 3. Embedded YouTube video between the welcome text and the next section */}
                <div style={{ display: "flex", justifyContent: "center", margin: "1rem 0" }}>
                  <iframe
                    width="560"
                    height="315"
                    src="https://www.youtube.com/embed/RKYKu71hIL4"
                    title="YouTube video player"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  ></iframe>
                </div>
              </BlockStack>
            </Card>
            {/* Card 4: What is a Child */}
            <Card>
              <BlockStack gap="400">
                <Text as="H1" variant="headingLg">
                  What is a Child
                </Text>
                <Text as="p" variant="bodyMd">
                  A Child is a product that shares its inventory with the Master.
                  Every time a Child is sold, the Master’s stock is automatically
                  adjusted. This is ideal for items sold both individually and in
                  packs, or for variations such as different colours or sizes of the
                  same product.
                </Text>
              </BlockStack>
            </Card>
            {/* Card 5: How to assign a Child to a Master */}
            <Card>
              <BlockStack gap="400">
                <Text as="H1" variant="headingLg">
                  How to assign a Child to a Master
                </Text>
                <Text as="p" variant="bodyMd">
                  Assigning a Child to a Master in Synclogic is simple within your
                  Shopify store:
                  <br />
                  <br />
                  1. Open Synclogic in your Shopify store.
                  <br />
                  2. Select the product that will serve as the Master.
                  <br />
                  3. Add the Child products that will share the Master’s inventory.
                  <br />
                  4. Configure the “Master Ratio” if the Child represents a pack or
                  fraction of the Master.
                  <br />
                  5. Save your changes – any stock
                  change in the Master will automatically update the Child
                  products.
                </Text>
                {/* 3. Embedded YouTube video between the welcome text and the next section */}
                <div style={{ display: "flex", justifyContent: "center", margin: "1rem 0" }}>
                  <iframe
                    width="560"
                    height="315"
                    src="https://www.youtube.com/embed/g5D4Z25ILA4"
                    title="YouTube video player"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  ></iframe>
                </div>
              </BlockStack>
            </Card>
            {/* Card 6: What is a Master Ratio */}
            <Card>
              <BlockStack gap="400">
                <Text as="H1" variant="headingLg">
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
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Resources
              </Text>
              <List>
                <List.Item>
                  <Link
                    url="https://shopify.dev/docs/apps/design-guidelines/navigation#app-nav"
                    target="_blank"
                    removeUnderline
                  >
                    App nav best practices
                  </Link>
                </List.Item>
              </List>
            </BlockStack>
          </Card>
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
