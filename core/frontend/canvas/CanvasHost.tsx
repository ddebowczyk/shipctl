import type { CanvasAdapterProps, CanvasAdapterView } from "./adapterTypes.ts";

export interface CanvasHostProps extends CanvasAdapterProps {
  /** Resolved during bootstrap and immutable for this application instance. */
  readonly adapter: CanvasAdapterView;
}

/** The single adapter seam. It owns no selection or fallback policy. */
export default function CanvasHost({ adapter: Adapter, ...props }: CanvasHostProps) {
  return <Adapter {...props} />;
}
