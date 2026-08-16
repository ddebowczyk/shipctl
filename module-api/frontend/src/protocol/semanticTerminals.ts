import { defineSemanticService } from "./semanticServices.ts";
import type {
  SemanticRequestOperation,
  SemanticStreamAttachRequest,
  SemanticStreamAttachment,
  SemanticStreamDelivery,
} from "./semanticServices.ts";
import type {
  AttachTerminalBytesInput,
  ResizeTerminalInput,
} from "./terminalSessions.ts";

/** Semantic-terminal access admitted to one module activation. */
export const SEMANTIC_TERMINAL_GRANTS = {
  attach: "semantic-terminal.attach",
  input: "semantic-terminal.input",
  inspect: "semantic-terminal.inspect",
} as const;

export type SemanticTerminalGrant =
  (typeof SEMANTIC_TERMINAL_GRANTS)[keyof typeof SEMANTIC_TERMINAL_GRANTS];

export const SEMANTIC_TERMINALS_ERROR_CODES = {
  invalidRequest: "semantic-terminals.request.invalid",
  cancelled: "semantic-terminals.request.cancelled",
  activationDisposed: "semantic-terminals.activation.disposed",
  denied: "semantic-terminals.activation.denied",
  notFound: "semantic-terminals.terminal.not-found",
  unavailable: "semantic-terminals.terminal.unavailable",
  transportFailed: "semantic-terminals.transport.failed",
  protocolFailed: "semantic-terminals.protocol.failed",
} as const;

export type SemanticTerminalsErrorCode =
  (typeof SEMANTIC_TERMINALS_ERROR_CODES)[keyof typeof SEMANTIC_TERMINALS_ERROR_CODES];

/** Reuse the host terminal and attachment identities from terminal sessions. */
export type SemanticTerminalId = AttachTerminalBytesInput["terminalId"];
export type SemanticTerminalAttachmentId = ResizeTerminalInput["attachmentId"];

export type SemanticTerminalRevision = number;
export type SemanticTerminalProjectedSpace = "active" | "viewport" | "screen" | "history";

export interface SemanticTerminalProjectedPoint {
  readonly column: number;
  readonly row: number;
}

export type SemanticTerminalAnchorId = number;

export interface SemanticTerminalAnchor {
  readonly id: SemanticTerminalAnchorId;
  readonly retained: boolean;
  readonly lossReported: boolean;
  readonly history: SemanticTerminalProjectedPoint | null;
  readonly screen: SemanticTerminalProjectedPoint | null;
  readonly viewport: SemanticTerminalProjectedPoint | null;
  readonly active: SemanticTerminalProjectedPoint | null;
}

export type SemanticTerminalSelectionMove =
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

export type SemanticTerminalSelectionRequest =
  | {
      readonly kind: "range";
      readonly space: SemanticTerminalProjectedSpace;
      readonly from: SemanticTerminalProjectedPoint;
      readonly to: SemanticTerminalProjectedPoint;
      readonly rectangle: boolean;
    }
  | {
      readonly kind: "word" | "line" | "output";
      readonly space: SemanticTerminalProjectedSpace;
      readonly at: SemanticTerminalProjectedPoint;
    }
  | { readonly kind: "all" }
  | { readonly kind: "extend"; readonly movement: SemanticTerminalSelectionMove }
  | { readonly kind: "clear" };

export interface SemanticTerminalSelectionState {
  readonly active: boolean;
  readonly text: string | null;
}

export interface SemanticTerminalColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type SemanticTerminalCellWidth = "narrow" | "wide" | "spacer_tail" | "spacer_head";
export type SemanticTerminalPrompt = "none" | "prompt" | "prompt_continuation";

export interface SemanticTerminalScreenRun {
  readonly glyphs: readonly string[];
  readonly width: SemanticTerminalCellWidth;
  readonly bold: boolean;
  readonly foreground: SemanticTerminalColor | null;
  readonly background: SemanticTerminalColor | null;
  readonly hyperlink?: string;
}

export interface SemanticTerminalScreenRow {
  readonly wrapped: boolean;
  readonly continuation: boolean;
  readonly prompt: SemanticTerminalPrompt;
  readonly runs: readonly SemanticTerminalScreenRun[];
}

export interface SemanticTerminalSelectionSpan {
  readonly start: number;
  readonly end: number;
}

export interface SemanticTerminalSelectionRow {
  readonly row: number;
  readonly spans: readonly SemanticTerminalSelectionSpan[];
}

export interface SemanticTerminalScreenState {
  readonly columns: number;
  readonly rows: number;
  readonly screen: "primary" | "alternate";
  readonly scrollbackRows: number;
  readonly cursor: {
    readonly column: number;
    readonly row: number;
    readonly visible: boolean;
    readonly pendingWrap: boolean;
    readonly shape: "block" | "block_hollow" | "bar" | "underline";
    readonly blinking: boolean;
  };
  readonly modes: {
    readonly wraparound: boolean;
    readonly bracketedPaste: boolean;
    readonly applicationCursorKeys: boolean;
    readonly applicationKeypad: boolean;
    readonly focusEvents: boolean;
    readonly mouseTracking: boolean;
    readonly insert: boolean;
    readonly reverseVideo: boolean;
    readonly origin: boolean;
  };
  readonly colors: {
    readonly foreground: SemanticTerminalColor | null;
    readonly background: SemanticTerminalColor | null;
    readonly palette: readonly SemanticTerminalColor[];
  };
  readonly damage: {
    readonly scope: "clean" | "partial" | "full";
    readonly rows: readonly number[];
  };
  readonly viewport: readonly SemanticTerminalScreenRow[];
  readonly selection: readonly SemanticTerminalSelectionRow[];
}

export interface SemanticTerminalHistoryCell {
  readonly text: string;
  readonly width: SemanticTerminalCellWidth;
  readonly bold: boolean;
  readonly foreground: SemanticTerminalColor | null;
  readonly background: SemanticTerminalColor | null;
  readonly selected: boolean;
  readonly hyperlink?: string;
}

export interface SemanticTerminalHistoryRow {
  readonly wrapped: boolean;
  readonly continuation: boolean;
  readonly prompt: SemanticTerminalPrompt;
  readonly cells: readonly SemanticTerminalHistoryCell[];
}

export interface SemanticTerminalHistoryWindow {
  readonly startRow: number;
  readonly historyRows: number;
  readonly rows: readonly SemanticTerminalHistoryRow[];
}

export type SemanticTerminalEffect =
  | { readonly kind: "title"; readonly title: string }
  | { readonly kind: "workingDirectory"; readonly uri: string }
  | { readonly kind: "bell" }
  | {
      readonly kind: "clipboard";
      readonly location: "standard" | "selection" | "primary";
      readonly contents: readonly {
        readonly mime: string;
        readonly data: string;
      }[];
    };

export interface SemanticTerminalModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly capsLock: boolean;
  readonly numLock: boolean;
}

export type SemanticTerminalInput =
  | {
      readonly kind: "key";
      readonly action: "press" | "release" | "repeat";
      readonly code: string;
      readonly text: string | null;
      readonly mods: SemanticTerminalModifiers;
      readonly composing: boolean;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "paste"; readonly text: string }
  | {
      readonly kind: "mouse";
      readonly action: "press" | "release" | "motion";
      readonly button:
        | "left" | "middle" | "right" | "four" | "five" | "six"
        | "seven" | "eight" | "nine" | "ten" | "eleven" | null;
      readonly mods: SemanticTerminalModifiers;
      readonly x: number;
      readonly y: number;
      readonly surface: {
        readonly screenWidth: number;
        readonly screenHeight: number;
        readonly cellWidth: number;
        readonly cellHeight: number;
        readonly paddingTop: number;
        readonly paddingBottom: number;
        readonly paddingLeft: number;
        readonly paddingRight: number;
      };
      readonly anyButtonPressed: boolean;
    }
  | { readonly kind: "focus"; readonly gained: boolean };

export interface SemanticTerminalScreenSnapshot {
  /** The stream boundary is the semantic revision, not a transport sequence. */
  readonly revision: SemanticTerminalRevision;
  readonly state: SemanticTerminalScreenState;
}

/** One replaceable screen frame and the parser effects caused by the same input occurrence. */
export interface SemanticTerminalScreenFrame {
  readonly revision: SemanticTerminalRevision;
  readonly state: SemanticTerminalScreenState;
  readonly effects: readonly SemanticTerminalEffect[];
}

export interface AttachSemanticTerminalScreenInput extends SemanticStreamAttachRequest {
  readonly terminalId: SemanticTerminalId;
  readonly claimsResize: boolean;
}

export interface SemanticTerminalScreenAttachment extends SemanticStreamAttachment {
  readonly terminalId: SemanticTerminalId;
  readonly live: boolean;
  readonly snapshot: SemanticTerminalScreenSnapshot;
  readonly active: boolean;
  /** Release transport events only after the consumer installs the snapshot. */
  activate(): void;
}

export interface SemanticTerminalScreenStream {
  attach(
    request: AttachSemanticTerminalScreenInput,
    listener: (
      delivery: SemanticStreamDelivery<SemanticTerminalScreenFrame>,
    ) => void | Promise<void>,
  ): Promise<SemanticTerminalScreenAttachment>;
}

export interface InspectSemanticTerminalSnapshotInput {
  readonly terminalId: SemanticTerminalId;
}

export interface InputSemanticTerminalInput {
  readonly terminalId: SemanticTerminalId;
  readonly input: SemanticTerminalInput;
}

export interface ResizeSemanticTerminalInput {
  readonly terminalId: SemanticTerminalId;
  readonly attachmentId: SemanticTerminalAttachmentId;
  readonly columns: number;
  readonly rows: number;
}

export interface ReadSemanticTerminalHistoryInput {
  readonly terminalId: SemanticTerminalId;
  readonly startRow: number;
  readonly rows: number;
}

export interface CreateSemanticTerminalAnchorInput {
  readonly terminalId: SemanticTerminalId;
  readonly space: SemanticTerminalProjectedSpace;
  readonly at: SemanticTerminalProjectedPoint;
}

export interface ResolveSemanticTerminalAnchorInput {
  readonly terminalId: SemanticTerminalId;
  readonly anchorId: SemanticTerminalAnchorId;
}

export interface ReleaseSemanticTerminalAnchorInput extends ResolveSemanticTerminalAnchorInput {}

export interface SelectSemanticTerminalInput {
  readonly terminalId: SemanticTerminalId;
  readonly request: SemanticTerminalSelectionRequest;
}

export interface InspectSemanticTerminalPasteInput {
  readonly text: string;
}

export interface InspectSemanticTerminalPublicationInput {
  readonly terminalId: SemanticTerminalId;
}

export interface SemanticTerminalPublicationStats {
  readonly ptyReads: number;
  readonly screenChanges: number;
  readonly screenProjections: number;
  readonly screenEncodes: number;
  readonly screenEncodedBytes: number;
  readonly screenRecipientDeliveries: number;
  readonly effectEvents: number;
  readonly effectEncodedBytes: number;
  readonly currentScreenTransactions: number;
  readonly currentScreenBytesQueued: number;
  readonly peakScreenBytesQueued: number;
  readonly currentEffectEventsQueued: number;
  readonly currentEffectBytesQueued: number;
  readonly peakEffectEventsQueued: number;
  readonly peakEffectBytesQueued: number;
}

export interface SemanticTerminalsService {
  readonly snapshot: SemanticRequestOperation<
    InspectSemanticTerminalSnapshotInput,
    SemanticTerminalScreenState,
    SemanticTerminalsErrorCode
  >;
  readonly input: SemanticRequestOperation<
    InputSemanticTerminalInput,
    { readonly encodedBytes: number },
    SemanticTerminalsErrorCode
  >;
  readonly resize: SemanticRequestOperation<
    ResizeSemanticTerminalInput,
    Readonly<Record<never, never>>,
    SemanticTerminalsErrorCode
  >;
  readonly history: SemanticRequestOperation<
    ReadSemanticTerminalHistoryInput,
    SemanticTerminalHistoryWindow,
    SemanticTerminalsErrorCode
  >;
  readonly createAnchor: SemanticRequestOperation<
    CreateSemanticTerminalAnchorInput,
    SemanticTerminalAnchor,
    SemanticTerminalsErrorCode
  >;
  readonly resolveAnchor: SemanticRequestOperation<
    ResolveSemanticTerminalAnchorInput,
    SemanticTerminalAnchor | null,
    SemanticTerminalsErrorCode
  >;
  readonly releaseAnchor: SemanticRequestOperation<
    ReleaseSemanticTerminalAnchorInput,
    { readonly released: boolean },
    SemanticTerminalsErrorCode
  >;
  readonly select: SemanticRequestOperation<
    SelectSemanticTerminalInput,
    SemanticTerminalSelectionState,
    SemanticTerminalsErrorCode
  >;
  readonly inspectPaste: SemanticRequestOperation<
    InspectSemanticTerminalPasteInput,
    { readonly safe: boolean },
    SemanticTerminalsErrorCode
  >;
  readonly publicationStats: SemanticRequestOperation<
    InspectSemanticTerminalPublicationInput,
    SemanticTerminalPublicationStats,
    SemanticTerminalsErrorCode
  >;
  readonly appMemory: SemanticRequestOperation<
    Readonly<Record<never, never>>,
    { readonly appRss: number },
    SemanticTerminalsErrorCode
  >;
  readonly screens: SemanticTerminalScreenStream;
}

/** Activation-owned semantic state layered on the public terminal-session identity. */
export const semanticTerminalsService = defineSemanticService<SemanticTerminalsService>(
  "shipctl.semantic-terminals",
  1,
);
