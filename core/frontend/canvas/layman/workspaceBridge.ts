// This is the pure Layman persistence integration. The host supplies its
// Tauri transport through Layman's SnapshotPort; this module knows no host
// command or event name.
export {
  createLaymanWorkspaceBridge,
  serializeState,
} from "react-layman";
export type {
  LaymanSnapshotPort,
  LaymanSnapshotSaveRequest,
  LaymanSnapshotSaveResult,
  LaymanWorkspaceBridge,
  LaymanWorkspaceBridgeEvent,
  LaymanWorkspaceUpdate,
} from "react-layman";
