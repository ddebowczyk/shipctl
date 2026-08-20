import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@shipctl/core/shell";
import "@shipctl/core/appearance/globals.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
