import React from "react";
import ReactDOM from "react-dom/client";
import { runModuleLoaderProbeIfRequested } from "@shipctl/core/host";
import { App } from "@shipctl/core/shell";
import "@shipctl/core/appearance/globals.css";

async function bootstrap(): Promise<void> {
  if (await runModuleLoaderProbeIfRequested()) return;
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
