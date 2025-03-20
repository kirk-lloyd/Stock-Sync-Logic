import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { loader as metafieldsLoader } from "./routes/models/metafields.app";

export const streamTimeout = 5000;

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  remixContext,
) {
  // Primero llamamos a la función original de Shopify
  addDocumentResponseHeaders(request, responseHeaders);
  
  // Luego agregamos nuestras propias cabeceras cruciales para iframes
  responseHeaders.set('Content-Security-Policy', "frame-ancestors https://*.myshopify.com https://admin.shopify.com;");
  responseHeaders.set('X-Frame-Options', 'ALLOW-FROM https://admin.shopify.com');
  
  // El resto permanece igual
  await metafieldsLoader({ request });

  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}