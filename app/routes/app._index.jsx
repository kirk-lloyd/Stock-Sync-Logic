import { useEffect } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  List,
  Link,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { Helmet } from "react-helmet";

// Loader function to authenticate the admin user.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

// Action function to create a new product and update its variant.
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  // Choose a random color for the product title.
  const color = ["Red", "Orange", "Yellow", "Green"][Math.floor(Math.random() * 4)];

  // GraphQL mutation to create a new product.
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    },
  );
  const responseJson = await response.json();
  const product = responseJson.data.productCreate.product;
  const variantId = product.variants.edges[0].node.id;

  // GraphQL mutation to update the product variant.
  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyRemixTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );
  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson.data.productCreate.product,
    variant: variantResponseJson.data.productVariantsBulkUpdate.productVariants,
  };
};

export default function Index() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  // Determine if the fetcher is currently loading or submitting.
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  // Extract the product ID from the fetched product data.
  const productId = fetcher.data?.product?.id.replace("gid://shopify/Product/", "");

  useEffect(() => {
    if (productId) {
      // Show a toast notification when a product is created.
      shopify.toast.show("Product created");
    }
  }, [productId, shopify]);

  // Note: The generateProduct function is no longer used as the button now navigates to /products/

  return (
    <Page>
      <Helmet>
        <script src="https://cdn.botpress.cloud/webchat/v2.3/inject.js"></script>
        <script src="https://files.bpcontent.cloud/2025/02/24/22/20250224223007-YAA5E131.js"></script>
      </Helmet>
      {/* Title bar with a button to create a new master (this button still triggers the POST action) */}
      <TitleBar title="Synchronize your inventory">
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
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                {/* 1. Banner GIF embedded at the top before the welcome text */}
                <img
                  src="https://valentinanails.com/wp-content/uploads/2025/02/giffycanvas.gif"
                  alt="Banner"
                  style={{ width: "100%", marginBottom: "1rem" }}
                />

                {/* 2. Welcome Section */}
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Welcome to Sync 🎉
                  </Text>
                  <Text variant="bodyMd" as="p">
                    Tool that helps you synchronize your inventory across multiple products.
                  </Text>
                </BlockStack>

                {/* 3. Embedded YouTube video between the welcome text and the next section */}
                <div style={{ display: "flex", justifyContent: "center", margin: "1rem 0" }}>
                  <iframe
                    width="560"
                    height="315"
                    src="https://www.youtube.com/embed/oEsBAfQXUHo"
                    title="YouTube video player"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  ></iframe>
                </div>

                {/* 4. "Get started with products" Section */}
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Get started with products
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Control your products and variants with our interface to manage your Master - Children, and mutiple variant relationship.
                  </Text>
                </BlockStack>

                {/* 5. Button group */}
                <InlineStack gap="300">
                  {/* The "Generate a product" button now navigates to the /products/ route */}
                  <Button url="/app/products/">
                    Manage all products 📦
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Sidebar section with help and tutorial links */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Help and tutorials 📚
                  </Text>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        How to use
                      </Text>
                      <Link
                        url="https://www.youtube.com/y91Pyv6xfOQ"
                        target="_blank"
                        removeUnderline
                      >
                        Video
                      </Link>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        How to add children
                      </Text>
                      <Link
                        url="https://www.youtube.com/g5D4Z25ILA4"
                        target="_blank"
                        removeUnderline
                      >
                        Video
                      </Link>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Creating a Master
                      </Text>
                      <span>
                        <Link
                          url="https://youtube.com/RKYKu71hIL4"
                          target="_blank"
                          removeUnderline
                        >
                          Video
                        </Link>
                      </span>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>
              {/*<Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Next steps
                  </Text>
                  <List>
                    <List.Item>
                      Build an{" "}
                      <Link
                        url="https://shopify.dev/docs/apps/getting-started/build-app-example"
                        target="_blank"
                        removeUnderline
                      >
                        example app
                      </Link>{" "}
                      to get started
                    </List.Item>
                    <List.Item>
                      Explore Shopify’s API with{" "}
                      <Link
                        url="https://shopify.dev/docs/apps/tools/graphiql-admin-api"
                        target="_blank"
                        removeUnderline
                      >
                        GraphiQL
                      </Link>
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>*/} 
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
