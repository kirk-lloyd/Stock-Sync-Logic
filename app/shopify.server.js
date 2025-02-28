// shopify.server.js

import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import jwt from "jsonwebtoken";

// Configure your Shopify app with the new embedded auth strategy enabled.
// Using PrismaSessionStorage for cookie-based sessions along with session tokens.
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October24,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma, {
    checkDatabaseInterval: 60 * 1000, // Check session in DB every minute.
  }),
  cookieOptions: {
    secure: process.env.NODE_ENV === "production" || process.env.USE_HTTPS === "true",
    sameSite: "None",
    maxAge: 86400 * 30, // Cookies valid for 30 days.
  },
  distribution: AppDistribution.AppStore,
  // Enable new embedded auth strategy using session tokens.
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  // Optional: if you support custom shop domains, configure them here.
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

/**
 * Verify a session token using jsonwebtoken.
 * This function decodes and validates the token using your API secret.
 * Additional checks (e.g. audience) can be added as needed.
 */
export function verifySessionToken(sessionToken) {
  try {
    const decodedToken = jwt.verify(sessionToken, process.env.SHOPIFY_API_SECRET, {
      algorithms: ["HS256"],
    });
    return decodedToken;
  } catch (error) {
    console.error("Invalid session token:", error);
    throw error;
  }
}

export default shopify;
export const apiVersion = ApiVersion.October24;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
export const registerAppInstalledWebhook = shopify.registerAppInstalledWebhook;
