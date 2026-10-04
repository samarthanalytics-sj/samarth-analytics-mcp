import { createRoot } from "react-dom/client";
import App from "./App";
import { hoistHashQuery } from "@shared/audit-deep-link";
import "./index.css";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// A <Link> opened in a new tab carries its query inside the hash
// ("#/audit?a=…&c=…"), which no route matches. Move it into the search, where
// in-app navigation puts it, before the router first reads the URL.
const hoisted = hoistHashQuery(window.location.search, window.location.hash);
if (hoisted) {
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + hoisted.search + hoisted.hash,
  );
}

createRoot(document.getElementById("root")!).render(<App />);
