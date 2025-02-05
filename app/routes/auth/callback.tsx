import { LoaderFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";

export const loader: LoaderFunction = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const code = url.searchParams.get("code");

  if (!shop || !code) {
    return json({ error: "Missing shop or code" }, { status: 400 });
  }

  // Intercambiar el código de autorización por el access token
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code,
    }),
  });

  if (!response.ok) {
    return json({ error: "Failed to fetch access token" }, { status: 400 });
  }

  const data = await response.json();

  // Guardar el access_token en la base de datos o una sesión
  console.log("Access Token:", data.access_token);

  // Redirigir al dashboard con la tienda
  return redirect(`/dashboard?shop=${shop}&access_token=${data.access_token}`);
};
