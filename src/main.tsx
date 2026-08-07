import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@shep/core/shell";
import "@shep/core/appearance/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
