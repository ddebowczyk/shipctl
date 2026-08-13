import AppShell from "./AppShell.tsx";
import type { CanvasAdapterId } from "@shipctl/core/platform";
import type { CanvasAdapterView } from "@shipctl/core/canvas/views";

export interface AppProps {
  readonly canvasAdapter: CanvasAdapterView;
  readonly canvasAdapterId: CanvasAdapterId;
}

function App({ canvasAdapter, canvasAdapterId }: AppProps) {
  return <AppShell canvasAdapter={canvasAdapter} canvasAdapterId={canvasAdapterId} />;
}

export default App;
