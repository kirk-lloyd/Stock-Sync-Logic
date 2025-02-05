// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Replace the HOST env var with SHOPIFY_APP_URL so that it doesn't break the remix server. The CLI will eventually
// stop passing in HOST, so we can remove this workaround after the next major release.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  serverBuildTarget: "node-cjs",
  server: "./server.js",
  ignoredRouteFiles: ["**/.*"],
  routes: async (defineRoutes) => {
    return defineRoutes((route) => {
      route("/app-load", "routes/app-load.js");
      route("/app-install", "routes/app-install.js");
    });
  },
};
