import type { PanelTabKind, UnifiedTab } from "../../lib/types";

export const PANEL_REFERENCE_SCHEMA_VERSION = 1 as const;

export const BUILTIN_PANEL_IDS = {
  git: "core.git",
  commands: "core.commands",
  launcher: "core.launcher",
} as const satisfies Record<PanelTabKind, `${string}.${string}`>;

const LEGACY_PANEL_LABELS = {
  git: "Files",
  commands: "Commands",
  launcher: "New Agent",
} as const satisfies Record<PanelTabKind, string>;

export interface PersistedPanelReference {
  readonly schemaVersion: typeof PANEL_REFERENCE_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly panelId: string;
  readonly label: string;
  /** Retained while legacy tab shapes remain readable. */
  readonly legacyKind?: string;
  /** Opaque module-owned state. The host must preserve it without interpretation. */
  readonly state?: unknown;
}

export type PanelReferenceUnavailableReason = "unknown" | "disabled" | "malformed";

export interface PanelReferenceRecovery {
  readonly reason: PanelReferenceUnavailableReason;
  readonly title: string;
  readonly description: string;
  readonly canRetry: boolean;
  readonly canRemove: true;
}

export interface HydratedPanelReference {
  readonly status: "available" | "unavailable";
  readonly source: "current" | "legacy" | "malformed";
  readonly instanceId: string;
  readonly panelId: string | null;
  readonly label: string;
  readonly legacyKind: string | null;
  readonly state: unknown;
  /** Original persisted value, retained even when it cannot currently resolve. */
  readonly raw: unknown;
  readonly recovery: PanelReferenceRecovery | null;
}

export interface HydratePanelReferenceOptions {
  readonly availablePanelIds: Iterable<string>;
  readonly knownPanelIds?: Iterable<string>;
  readonly legacyPanels?: Iterable<LegacyPanelDefinition>;
  readonly fallbackInstanceId?: string;
}

export interface LegacyPanelDefinition {
  readonly kind: string;
  readonly panelId: string;
  readonly label: string;
}

interface LegacyPanelTabShape {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly panelId: string;
}

const BUILTIN_LEGACY_PANELS: readonly LegacyPanelDefinition[] = Object.entries(
  BUILTIN_PANEL_IDS,
).map(([kind, panelId]) => ({
  kind,
  panelId,
  label: LEGACY_PANEL_LABELS[kind as PanelTabKind],
}));

const KNOWN_BUILTIN_PANEL_IDS = new Set<string>(Object.values(BUILTIN_PANEL_IDS));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPanelId(value: unknown): value is string {
  return isNonEmptyString(value) && /^[^.\s]+\.[^.\s]+(?:\.[^.\s]+)*$/.test(value);
}

function readLegacyPanelTab(
  value: unknown,
  legacyPanels: ReadonlyMap<string, LegacyPanelDefinition>,
): LegacyPanelTabShape | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.kind)) return null;
  const definition = legacyPanels.get(value.kind);
  if (!definition) return null;
  return {
    id: value.id,
    kind: value.kind,
    label: isNonEmptyString(value.label) ? value.label : definition.label,
    panelId: definition.panelId,
  };
}

function readCurrentPanelReference(value: unknown): PersistedPanelReference | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== PANEL_REFERENCE_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(value.instanceId) || !isPanelId(value.panelId)) return null;
  if (!isNonEmptyString(value.label)) return null;
  if (value.legacyKind !== undefined && !isNonEmptyString(value.legacyKind)) return null;

  return {
    schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
    instanceId: value.instanceId,
    panelId: value.panelId,
    label: value.label,
    ...(value.legacyKind === undefined ? {} : { legacyKind: value.legacyKind }),
    ...(Object.prototype.hasOwnProperty.call(value, "state") ? { state: value.state } : {}),
  };
}

function recoveryFor(reason: PanelReferenceUnavailableReason, panelId: string | null): PanelReferenceRecovery {
  if (reason === "malformed") {
    return {
      reason,
      title: "Panel state could not be read",
      description: "The saved entry was kept intact. Remove it, or retain it for a newer Shep version.",
      canRetry: false,
      canRemove: true,
    };
  }

  const displayId = panelId ?? "this panel";
  return {
    reason,
    title: reason === "disabled" ? "Panel is disabled" : "Panel is unavailable",
    description: reason === "disabled"
      ? `${displayId} is known but is not enabled in this build.`
      : `${displayId} is not registered in this build. Its saved state has been retained.`,
    canRetry: true,
    canRemove: true,
  };
}

export function toPersistedPanelReference(
  reference: Omit<PersistedPanelReference, "schemaVersion">,
): PersistedPanelReference {
  return {
    schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
    ...reference,
  };
}

export function panelIdForTabKind(kind: string): `${string}.${string}` | null {
  return kind in BUILTIN_PANEL_IDS
    ? BUILTIN_PANEL_IDS[kind as PanelTabKind]
    : null;
}

export function panelIdForTab(tab: UnifiedTab): `${string}.${string}` | null {
  if (tab.kind === "panel") return tab.panelId;
  return panelIdForTabKind(tab.kind);
}

export function hydratePanelReference(
  raw: unknown,
  options: HydratePanelReferenceOptions,
): HydratedPanelReference {
  const availablePanelIds = new Set(options.availablePanelIds);
  const knownPanelIds = new Set(options.knownPanelIds ?? KNOWN_BUILTIN_PANEL_IDS);
  const legacyPanels = new Map(
    [...BUILTIN_LEGACY_PANELS, ...(options.legacyPanels ?? [])]
      .map((definition) => [definition.kind, definition] as const),
  );
  const current = readCurrentPanelReference(raw);
  const legacy = current === null ? readLegacyPanelTab(raw, legacyPanels) : null;

  if (current === null && legacy === null) {
    const fallbackId = isRecord(raw) && isNonEmptyString(raw.id)
      ? raw.id
      : (options.fallbackInstanceId ?? "unavailable-panel");
    const fallbackLabel = isRecord(raw) && isNonEmptyString(raw.label)
      ? raw.label
      : "Unavailable panel";
    return {
      status: "unavailable",
      source: "malformed",
      instanceId: fallbackId,
      panelId: null,
      label: fallbackLabel,
      legacyKind: null,
      state: undefined,
      raw,
      recovery: recoveryFor("malformed", null),
    };
  }

  const reference = current ?? {
    schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
    instanceId: legacy!.id,
    panelId: legacy!.panelId,
    label: legacy!.label,
    legacyKind: legacy!.kind,
  };
  const source = current === null ? "legacy" : "current";
  const status = availablePanelIds.has(reference.panelId) ? "available" : "unavailable";
  const unavailableReason = knownPanelIds.has(reference.panelId) ? "disabled" : "unknown";

  return {
    status,
    source,
    instanceId: reference.instanceId,
    panelId: reference.panelId,
    label: reference.label,
    legacyKind: reference.legacyKind ?? null,
    state: reference.state,
    raw,
    recovery: status === "available" ? null : recoveryFor(unavailableReason, reference.panelId),
  };
}
