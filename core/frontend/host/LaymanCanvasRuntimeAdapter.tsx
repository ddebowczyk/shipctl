import { useEffect, useRef } from "react";
import type {
  LaymanController,
  LaymanWorkspaceBridge,
  LaymanWorkspaceBridgeEvent,
} from "react-layman";

import {
  createLaymanCanvasController,
  createLaymanWorkspaceBridge,
  LaymanCanvas,
  LAYMAN_CANVAS_WORKSPACE_ID,
} from "@shipctl/core/canvas/views";
import type {
  CanvasAdapterProps,
  LaymanCanvasPaneData,
} from "@shipctl/core/canvas/views";
import { useNoticeStore } from "../shared/useNoticeStore.ts";
import {
  createTauriWorkspaceLayoutSnapshotPort,
  type WorkspaceLayoutPortError,
} from "./laymanWorkspaceLayoutPort.ts";

let fallbackOriginSequence = 0;

function createOriginId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `shipctl-webview-${crypto.randomUUID()}`;
  }
  fallbackOriginSequence += 1;
  return `shipctl-webview-${Date.now()}-${fallbackOriginSequence}`;
}

function stableCode(message: string): string {
  return message.match(/CANVAS_LAYOUT_[A-Z_]+/)?.[0] ?? "CANVAS_LAYOUT_PERSISTENCE_FAILED";
}

function noticeMessage(message: string): string {
  const code = stableCode(message);
  const detail = message
    .replace(`[${code}]`, "")
    .replace(`${code}:`, "")
    .trim();
  return `[${code}] ${detail || "The layout operation failed."} The current canvas remains available.`;
}

function reportLayoutFailure(title: string, message: string): void {
  useNoticeStore.getState().pushNotice({
    tone: "error",
    title,
    message: noticeMessage(message),
  });
}

function reportLayoutConflict(): void {
  useNoticeStore.getState().pushNotice({
    tone: "info",
    title: "Canvas layout updated",
    message: "[CANVAS_LAYOUT_REVISION_CONFLICT] A newer canvas layout was saved by another Shipctl view. The current canvas was restored.",
  });
}

function reportBridgeEvent(event: LaymanWorkspaceBridgeEvent<LaymanCanvasPaneData>): void {
  switch (event.type) {
    case "load-failed":
      reportLayoutFailure("Canvas layout could not be restored", event.message);
      return;
    case "save-failed":
      reportLayoutFailure("Canvas layout could not be saved", event.message);
      return;
    case "subscribe-failed":
      reportLayoutFailure("Canvas layout updates are unavailable", event.message);
      return;
    case "external-update-failed":
      reportLayoutFailure("Canvas layout update could not be applied", event.message);
      return;
    case "save-conflicted":
      reportLayoutConflict();
      return;
    case "save-conflict-failed":
      reportLayoutFailure("Canvas layout conflict could not be resolved", event.message);
      return;
    default:
      return;
  }
}

function reportTransportError(error: WorkspaceLayoutPortError): void {
  reportLayoutFailure("Canvas layout update could not be applied", error.message);
}

/**
 * Supplies the selected Layman canvas with host-owned persistence. The pure
 * renderer remains in `canvas/layman`; this adapter owns browser transport,
 * lifecycle, and inspectable failure reporting.
 */
export default function LaymanCanvasRuntimeAdapter(props: CanvasAdapterProps) {
  const controllerRef = useRef<LaymanController<LaymanCanvasPaneData> | null>(null);
  const bridgeRef = useRef<LaymanWorkspaceBridge<LaymanCanvasPaneData> | null>(null);

  if (!controllerRef.current) {
    const controller = createLaymanCanvasController();
    controllerRef.current = controller;
    bridgeRef.current = createLaymanWorkspaceBridge({
      workspaceId: LAYMAN_CANVAS_WORKSPACE_ID,
      originId: createOriginId(),
      controller,
      snapshots: createTauriWorkspaceLayoutSnapshotPort({
        onTransportError: reportTransportError,
      }),
      onEvent: reportBridgeEvent,
    });
  }

  const bridge = bridgeRef.current;
  if (!bridge) {
    throw new Error("Layman canvas runtime could not initialize its workspace bridge.");
  }

  useEffect(() => {
    void bridge.start().catch((error: unknown) => {
      reportLayoutFailure(
        "Canvas layout could not be restored",
        error instanceof Error ? error.message : String(error),
      );
    });
    return () => {
      void bridge.stop().catch((error: unknown) => {
        reportLayoutFailure(
          "Canvas layout could not stop cleanly",
          error instanceof Error ? error.message : String(error),
        );
      });
    };
  }, [bridge]);

  return <LaymanCanvas {...props} controller={bridge.controller} />;
}
