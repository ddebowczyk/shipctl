import { useCallback, useEffect, useState } from "react";
import type { ModulePanelProps } from "@shep/module-api";

import { pingFixture } from "./client";

export default function FixturePanel({ setTitle }: ModulePanelProps) {
  const [result, setResult] = useState("Invoking fixture command…");

  const ping = useCallback(async () => {
    setResult("Invoking fixture command…");
    try {
      setResult(await pingFixture());
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    setTitle("Module Fixture");
    void ping();
    return () => setTitle(null);
  }, [ping, setTitle]);

  return (
    <main aria-label="Module fixture" style={{ padding: 24 }}>
      <h1>Module fixture</h1>
      <p data-testid="fixture-result">{result}</p>
      <button type="button" onClick={() => void ping()}>Ping again</button>
    </main>
  );
}
