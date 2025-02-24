// app/components/Layout.jsx
import { Link } from "@remix-run/react";

const saveAccessToken = async (shop, token) => {
    console.log(`Access token for shop ${shop} saved: ${token}`);
};


export default function Layout({ children }) {
    return (
        <div>
            <header>
            </header>
            <main>{children}</main>
            <footer>
                <p style={{ display: "flex", justifyContent: "center", margin: "1rem 0" }}>© {new Date().getFullYear()} Stock Sync Logic</p>
            </footer>
        </div>
    );
}
