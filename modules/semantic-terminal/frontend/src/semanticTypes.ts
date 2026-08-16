/**
 * Semantic-terminal protocol facts.
 *
 * These types describe interpreter-owned state. They do not describe a PTY,
 * terminal lifetime, or a host attachment.
 */

import type { SemanticTerminalEffect } from "./browserInteraction.ts";
import type { TerminalHostDescriptor } from "@shipctl/module-api";

export type TerminalProjectedSpace = "active" | "viewport" | "screen" | "history";

export interface TerminalProjectedPoint {
  readonly column: number;
  readonly row: number;
}

export type TerminalAnchorId = number;

export type TerminalSelectionMove =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "page_up"
  | "page_down"
  | "beginning_of_line"
  | "end_of_line";

export type TerminalSelectionRequest =
  | {
      readonly kind: "range";
      readonly space: TerminalProjectedSpace;
      readonly from: TerminalProjectedPoint;
      readonly to: TerminalProjectedPoint;
      readonly rectangle: boolean;
    }
  | { readonly kind: "word"; readonly space: TerminalProjectedSpace; readonly at: TerminalProjectedPoint }
  | { readonly kind: "line"; readonly space: TerminalProjectedSpace; readonly at: TerminalProjectedPoint }
  | { readonly kind: "output"; readonly space: TerminalProjectedSpace; readonly at: TerminalProjectedPoint }
  | { readonly kind: "all" }
  | { readonly kind: "extend"; readonly movement: TerminalSelectionMove }
  | { readonly kind: "clear" };

export interface TerminalSelectionState {
  readonly active: boolean;
  readonly text: string | null;
}

export interface TerminalScreenState {
  readonly columns: number;
  readonly rows: number;
  readonly screen: string;
  readonly scrollbackRows: number;
  readonly cursor: Record<string, unknown>;
  readonly modes: Record<string, unknown>;
  readonly colors: Record<string, unknown>;
  readonly damage: Record<string, unknown>;
  readonly viewport: readonly unknown[];
  readonly selection: readonly unknown[];
}

export type TerminalEffect = SemanticTerminalEffect;

/** The result of one semantic input request. */
export type TerminalInputOutcome =
  | { readonly status: "accepted"; readonly encodedBytes: number }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly error: unknown };

/** A semantic frame revision. The interpreter, not host lifecycle, owns it. */
export type TerminalRevision = number;

/** The byte baseline retained only while the migration protocol is present. */
export interface TerminalReplay {
  readonly revision: TerminalRevision;
  readonly columns: number;
  readonly rows: number;
  readonly bytes: readonly number[];
}

/**
 * Wire occurrences decoded by semantic-terminal.
 *
 * Lifecycle occurrences use only the public host descriptor, so this module
 * never depends on core's richer terminal record shape.
 */
export type SemanticTerminalWireEvent =
  | {
      readonly event: "output";
      readonly sequence: number;
      readonly revision: TerminalRevision;
      readonly data: readonly number[];
    }
  | {
      readonly event: "replay";
      readonly sequence: number;
      readonly replay: TerminalReplay;
    }
  | {
      readonly event: "screen";
      readonly sequence: number;
      readonly revision: TerminalRevision;
      readonly state: TerminalScreenState;
    }
  | {
      readonly event: "effects";
      readonly sequence: number;
      readonly effects: readonly TerminalEffect[];
    }
  | {
      readonly event: "metadata_changed" | "agent_activity_changed";
      readonly sequence: number;
      readonly descriptor: TerminalHostDescriptor;
    }
  | {
      readonly event: "exited";
      readonly sequence: number;
    }
  | {
      readonly event: "resync_required" | "detached";
      readonly sequence: number;
      readonly reason: string;
    };
