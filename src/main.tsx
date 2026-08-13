import React from "react";
import ReactDOM from "react-dom/client";
import { resolveCanvasAdapter } from "@shipctl/core/canvas/views";
import { bindCanvasAdapterRuntime } from "@shipctl/core/host/layman";
import { getCanvasAdapter, getErrorMessage } from "@shipctl/core/platform";
import { App } from "@shipctl/core/shell";
import "@shipctl/core/appearance/globals.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

void bootstrap();

async function bootstrap() {
  try {
    const canvasAdapterId = await getCanvasAdapter();
    const canvasAdapter = bindCanvasAdapterRuntime(
      canvasAdapterId,
      resolveCanvasAdapter(canvasAdapterId),
    );
    root.render(
      <React.StrictMode>
        <App canvasAdapter={canvasAdapter} canvasAdapterId={canvasAdapterId} />
      </React.StrictMode>,
    );
  } catch (error) {
    root.render(
      <React.StrictMode>
        <main className="min-h-screen p-6 text-[var(--text-primary)]" role="alert">
          <h1 className="text-lg font-semibold">Shipctl could not start</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Check the global configuration, then restart Shipctl.
          </p>
          <pre className="mt-4 whitespace-pre-wrap text-sm text-red-300">
            {getErrorMessage(error)}
          </pre>
        </main>
      </React.StrictMode>,
    );
  }
}
