import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node";
import { Outlet, Route, Routes } from "react-router-dom";
import ProductsTable from "./app.products";
import SyncView from "./app.sync";

// Loader function to fetch metafield status
export let loader = async ({ request }) => {
  let metafieldStatus = request.metafieldStatus || 'unknown';
  return json({ metafieldStatus });
};

function App() {
  return (
    <Routes>
      <Route path="/app/products" element={<ProductsTable />} />
      <Route path="/app/sync/:productId" element={<SyncView />} />
      {/* ...other routes... */}
    </Routes>
  );
}

export default App;