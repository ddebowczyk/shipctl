import { installTerminalScenarioHarness } from "@shipctl/core/terminal";
import AppShell from "./AppShell.tsx";

// Dev builds expose the packaged-app scenario harness on globalThis; release
// builds fold this to a no-op and drop the harness entirely. See
// "core/frontend/terminal/scenarios/terminalScenarioEntry.ts".
installTerminalScenarioHarness();

function App() {
  return <AppShell />;
}

export default App;
