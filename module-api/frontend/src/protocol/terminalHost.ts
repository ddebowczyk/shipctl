/** A build-installed terminal implementation identity. */
declare const terminalDriverIdBrand: unique symbol;
export type TerminalDriverId = string & { readonly [terminalDriverIdBrand]: true };

export function terminalDriverId(value: string): TerminalDriverId {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`Invalid terminal driver ID: ${value}`);
  }
  return value as TerminalDriverId;
}

export type TerminalHostLifecycle = "starting" | "running" | "closing" | "exited";

/** Renderer-independent public facts about one host-owned PTY. */
export interface TerminalHostDescriptor {
  readonly id: string;
  readonly driverId: TerminalDriverId;
  readonly lifecycle: TerminalHostLifecycle;
  readonly columns: number;
  readonly rows: number;
  readonly label: string;
  readonly projectPath: string | null;
}

export type TerminalHostLifecycleEvent =
  | { readonly type: "upserted"; readonly descriptor: TerminalHostDescriptor }
  | { readonly type: "removed"; readonly terminalId: string };

/** One exact ordered occurrence from the child PTY. */
export interface RawTerminalOccurrence {
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

export interface RawTerminalAttachment {
  readonly id: string;
  readonly terminalId: string;
  /** The driver that the host authorized for this attachment. */
  readonly driverId: TerminalDriverId;
  readonly occurrences: AsyncIterable<RawTerminalOccurrence>;
  detach(): Promise<void>;
}

export interface TerminalHostLaunchRequest {
  readonly driverId: TerminalDriverId;
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly cwd: string;
  readonly projectPath?: string;
  readonly label: string;
  readonly columns: number;
  readonly rows: number;
}
