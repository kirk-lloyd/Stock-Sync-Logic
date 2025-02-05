import { useEffect } from "react";
import { useFetcher } from "@remix-run/react";
import { authenticate } from "../../shopify.server";

/**
 * Loader function to authenticate admin before rendering the page.
 * It calls the action function to ensure metafield definitions exist.
 */
export const loader = async ({ request }) => {
  await authenticate.admin(request); // Authenticate admin user
  await action({ request }); // Execute action to create/check metafield definitions
  return null;
};

/**
 * Helper function to fetch GraphQL data and handle errors.
 */
const fetchGraphQL = async (admin, query, variables) => {
  const response = await admin.graphql(query, variables);
  const jsonResponse = await response.json();
  if (!response.ok || jsonResponse.errors) {
    throw new Error("Failed to fetch GraphQL data");
  }
  return jsonResponse;
};

/**
 * Action function to create metafield definitions if they do not exist.
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request); // Authenticate admin user

  // Define the required metafields
  const requiredMetafields = [
    {
      namespace: "projektstocksyncchildren",
      key: "childrenkey",
      name: "Projekt Sync - Product Children",
      description:
        "Defines which children stock should be updated by the product master. Used if product is set as stock master.",
      type: "list.variant_reference",
      ownerType: "PRODUCTVARIANT",
    },
    {
      namespace: "projektstocksyncmaster",
      key: "master",
      name: "Projekt Sync - Product Master",
      description:
        "Set to true if this product is the stock sync master for inventory management. A stock master cannot be a stock child.",
      type: "boolean",
      ownerType: "PRODUCTVARIANT",
    },
  ];

  for (const metafield of requiredMetafields) {
    try {
      // Query for existing metafield definitions
      const existingDefinitions = await fetchGraphQL(
        admin,
        `#graphql
          query GetMetafieldDefinitions($namespace: String!, $ownerType: MetafieldOwnerType!) {
            metafieldDefinitions(first: 100, namespace: $namespace, ownerType: $ownerType) {
              edges {
                node {
                  key
                }
              }
            }
          }
        `,
        {
          variables: {
            namespace: metafield.namespace,
            ownerType: metafield.ownerType,
          },
        }
      );

      const existingKeys = existingDefinitions.data.metafieldDefinitions.edges.map(
        (edge) => edge.node.key
      );

      if (!existingKeys.includes(metafield.key)) {
        // Create the metafield definition if it doesn't exist
        const response = await fetchGraphQL(
          admin,
          `#graphql
            mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
              metafieldDefinitionCreate(definition: $definition) {
                createdDefinition {
                  id
                  name
                }
                userErrors {
                  field
                  message
                  code
                }
              }
            }
          `,
          { variables: { definition: metafield } }
        );

        if (response.data.metafieldDefinitionCreate.userErrors.length > 0) {
          console.error("User errors:", response.data.metafieldDefinitionCreate.userErrors);
        } else {
          console.log("Metafield created:", response.data.metafieldDefinitionCreate.createdDefinition);
        }
      } else {
        console.log(`Metafield "${metafield.key}" already exists.`);
      }
    } catch (error) {
      console.error("Error checking or creating metafield:", error);
    }
  }

  return null;
};
