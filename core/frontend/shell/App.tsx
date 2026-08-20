import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_RUNTIME_SETTINGS,
  hostConfigurationRuntime,
  type CanvasAdapterId,
} from "@shipctl/core/configuration";
import { resolveCanvasAdapter, type CanvasAdapterView } from "@shipctl/core/canvas/views";
import { bindCanvasAdapterRuntime } from "@shipctl/core/host/layman";

import AppShell from "./AppShell.tsx";
import { getErrorMessage } from "../platform/errors.ts";

function ConfigurationFailure({ error }: { readonly error: unknown }) {
  return (
    <main className="min-h-screen p-6 text-[var(--text-primary)]" role="alert">
      <h1 className="text-lg font-semibold">Shipctl could not load configuration</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Fix the named configuration record or restore a valid bundled adapter value, then restart Shipctl.
      </p>
      <pre className="mt-4 whitespace-pre-wrap text-sm text-red-300">
        {getErrorMessage(error)}
      </pre>
    </main>
  );
}

function App() {
  const [canvasAdapterId, setCanvasAdapterId] = useState<CanvasAdapterId>(
    DEFAULT_RUNTIME_SETTINGS.canvasAdapter,
  );
  const [configurationError, setConfigurationError] = useState<unknown>(null);

  // This is one-time external configuration initialization. The first render
  // intentionally uses the TypeScript default and never blocks on Tauri.
  useEffect(() => {
    let active = true;
    void hostConfigurationRuntime().resolve("runtime").then(
      ({ value }) => {
        if (active) setCanvasAdapterId(value.canvasAdapter);
      },
      (error) => {
        if (active) setConfigurationError(error);
      },
    );
    return () => { active = false; };
  }, []);

  const canvasAdapter = useMemo<CanvasAdapterView>(() => bindCanvasAdapterRuntime(
    canvasAdapterId,
    resolveCanvasAdapter(canvasAdapterId),
  ), [canvasAdapterId]);

  if (configurationError !== null) return <ConfigurationFailure error={configurationError} />;
  return <AppShell canvasAdapter={canvasAdapter} canvasAdapterId={canvasAdapterId} />;
}

export default App;
