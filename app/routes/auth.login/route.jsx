import { useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { login, registerAppInstalledWebhook } from "../../shopify.server"; // Importing necessary server utilities
import { loginErrorMessage } from "./error.server";
import { redirect } from "@remix-run/node";

// Links function for loading Polaris styles
export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

/**
 * Loader function handles the login flow and registers the APP_INSTALLED webhook.
 */
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const accessToken = url.searchParams.get("access_token");

  if (!shop || !accessToken) {
    throw new Error("Missing shop or access token");
  }

  // Register the APP_INSTALLED webhook
  await registerAppInstalledWebhook(shop, accessToken);

  // Redirect to the dashboard or initial page
  return redirect(`/dashboard?shop=${shop}`);
};

/**
 * Action function handles login and retrieves necessary data for rendering.
 */
export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

/**
 * The Auth component handles the user interface for logging in.
 */
export default function Auth() {
  const loaderData = useLoaderData(); // Data from the loader
  const actionData = useActionData(); // Data from the action
  const [shop, setShop] = useState(""); // State for the shop input
  const { errors } = actionData || loaderData;

  return (
    <PolarisAppProvider i18n={loaderData.polarisTranslations}>
      <Page>
        <Card>
          <Form method="post">
            <FormLayout>
              {/* Heading for the login form */}
              <Text variant="headingMd" as="h2">
                Log in
              </Text>

              {/* Input field for the shop domain */}
              <TextField
                type="text"
                name="shop"
                label="Shop domain"
                helpText="example.myshopify.com"
                value={shop}
                onChange={setShop}
                autoComplete="on"
                error={errors?.shop}
              />

              {/* Submit button for the form */}
              <Button submit>Log in</Button>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
