// app/reauth-callback.jsx

import { redirect } from "@remix-run/node";
import React from "react";

/**
 * This loader handles reauthentication callbacks.
 * It validates that the required query parameters are present and then redirects
 * to the authentication route with a return_to parameter.
 */
export async function loader({ request }) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host") || "";
  const chargeId = url.searchParams.get("charge_id") || "";

  if (!shop || !chargeId) {
    return new Response("Missing shop or charge_id", { status: 400 });
  }

  // Build a return_to URL that sends the merchant back to the callback after authentication.
  const returnTo = encodeURIComponent(`/app/settings-callback?shop=${shop}&host=${host}&charge_id=${chargeId}`);
  console.log("[reauth-callback loader] Redirecting to /auth with shop:", shop, "and return_to:", returnTo);
  return redirect(`/auth?shop=${shop}&return_to=${returnTo}`);
}

export default function ReauthCallback() {
  return <div>Reauthenticating... Please wait.</div>;
}
