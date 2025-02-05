import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  Card,
  Layout,
  Page,
  Thumbnail,
  TextContainer,
  Tag,
} from "@shopify/polaris";

// Loader function to fetch a single product and its children with inventory quantities
export const loader = async ({ request, params }) => {
  console.log("Loader function executed"); // Log statement to verify execution
  const { admin } = await authenticate.admin(request);
  const productId = decodeURIComponent(params.productId);
  console.log("Decoded productId:", productId); // Log the decoded productId

  try {
    // GraphQL query to fetch a single product with its children and inventory quantities
    const response = await admin.graphql(
      `#graphql
      query GetProductWithChildren($id: ID!) {
        product(id: $id) {
          id
          title
          createdAt
          images(first: 1) {
            edges {
              node {
                originalSrc
              }
            }
          }
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
          variants(first: 100) {
            edges {
              node {
                id
                inventoryQuantity
              }
            }
          }
        }
      }`,
      {
        variables: {
          id: productId,
        },
      }
    );

    // Parse the response and extract product data
    const data = await response.json();
    const product = data.data.product;
    console.log("Fetched product data:", product); // Log the fetched product data
    return json({ product });
  } catch (error) {
    console.error("Error fetching product:", error);
    return json({ product: null, error: error.message }, { status: 500 });
  }
};

const SyncView = () => {
  // Initial data from the loader
  const { product } = useLoaderData();
  console.log("Loader data:", product); // Log the loader data

  if (!product) {
    return <p>Product not found</p>;
  }

  const childrenMetafield = product.metafields.edges.find(
    (mf) => mf.node.key === "childrenkey"
  );
  const children = childrenMetafield ? JSON.parse(childrenMetafield.node.value) : [];
  console.log("Children products:", children); // Log the children products

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <Card>
            <Card.Section>
              <Thumbnail
                source={product.images.edges[0]?.node.originalSrc || ""}
                alt={product.title}
              />
              <TextContainer>
                <h1>{product.title}</h1>
                <p>Created At: {new Date(product.createdAt).toLocaleDateString()}</p>
                <p>
                  Inventory Quantity:{" "}
                  {product.variants.edges.reduce(
                    (total, variant) => total + variant.node.inventoryQuantity,
                    0
                  )}
                </p>
              </TextContainer>
            </Card.Section>
            {children.length > 0 && (
              <Card.Section title="Related Products">
                {children.map((child) => {
                  const childProduct = product.variants.edges.find((v) => v.node.id === child);
                  return (
                    <TextContainer key={child}>
                      <Tag>Child Variant ID: {child}</Tag>
                      <p>
                        Inventory Quantity:{" "}
                        {childProduct
                          ? childProduct.node.inventoryQuantity
                          : "Not available"}
                      </p>
                    </TextContainer>
                  );
                })}
              </Card.Section>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
};

export default SyncView;
