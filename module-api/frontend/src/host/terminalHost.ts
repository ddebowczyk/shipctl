import type {
  RawTerminalAttachment,
  TerminalDriverId,
  TerminalHostDescriptor,
  TerminalHostLaunchRequest,
  TerminalHostLifecycleEvent,
} from "../protocol/terminalHost";
import type { ModuleHostServices } from "./services";
import type { ModuleActivationContext } from "../protocol/semanticServices";

/**
 * The only common frontend authority for terminal implementations. It exposes
 * lifecycle and bytes, never terminal meaning, screen state, or Tauri invoke.
 */
export interface TerminalHostPort {
  list(): Promise<readonly TerminalHostDescriptor[]>;
  launch(request: TerminalHostLaunchRequest): Promise<TerminalHostDescriptor>;
  observe(listener: (event: TerminalHostLifecycleEvent) => void): Promise<() => void>;
  /**
   * The provider states its id on attachment. The host must reject a provider
   * that does not match the terminal's immutable selected driver.
   */
  attachRaw(
    terminalId: string,
    driverId: TerminalDriverId,
    claimsResize: boolean,
  ): Promise<RawTerminalAttachment>;
  write(terminalId: string, bytes: Uint8Array): Promise<void>;
  resize(
    terminalId: string,
    attachmentId: string,
    columns: number,
    rows: number,
  ): Promise<void>;
  close(terminalId: string): Promise<void>;
}

export interface TerminalPresentationProps {
  readonly terminalId: string;
  readonly descriptor: TerminalHostDescriptor;
  readonly visible: boolean;
  /** Activation-scoped semantic services. Native transports stay private. */
  readonly activation: ModuleActivationContext;
  /** Host browser services available to the selected presentation only. */
  readonly services: Pick<
    ModuleHostServices,
    "notices" | "externalLinks" | "terminalPresentation"
  >;
}
