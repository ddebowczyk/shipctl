import type { UnifiedTab } from "../../lib/types";

export const PANEL_REFERENCE_SCHEMA_VERSION = 1 as const;

export interface PersistedPanelReference {
  readonly schemaVersion: typeof PANEL_REFERENCE_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly panelId: string;
  readonly label: string;
  /** Records which pre-registry tab kind was migrated into this reference. */
  readonly migrationKind?: string;
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
  readonly source: "current" | "migrated" | "malformed";
  readonly instanceId: string;
  readonly panelId: string | null;
  readonly label: string;
  readonly migrationKind: string | null;
  readonly state: unknown;
  /** Original persisted value, retained even when it cannot currently resolve. */
  readonly raw: unknown;
  readonly recovery: PanelReferenceRecovery | null;
}

export interface HydratePanelReferenceOptions {
  readonly availablePanelIds: Iterable<string>;
  readonly knownPanelIds?: Iterable<string>;
  readonly migrationAliases?: Iterable<PanelMigrationAlias>;
  readonly fallbackInstanceId?: string;
}

export interface PanelMigrationAlias {
  readonly kind: string;
  readonly panelId: string;
  readonly label: string;
}

interface MigratablePanelTabShape {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly panelId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPanelId(value: unknown): value is string {
  return isNonEmptyString(value) && /^[^.\s]+\.[^.\s]+(?:\.[^.\s]+)*$/.test(value);
}

function readMigratablePanelTab(
  value: unknown,
  migrationAliases: ReadonlyMap<string, PanelMigrationAlias>,
): MigratablePanelTabShape | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.kind)) return null;
  const definition = migrationAliases.get(value.kind);
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
  if (value.migrationKind !== undefined && !isNonEmptyString(value.migrationKind)) return null;

  return {
    schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
    instanceId: value.instanceId,
    panelId: value.panelId,
    label: value.label,
    ...(value.migrationKind === undefined ? {} : { migrationKind: value.migrationKind }),
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

export function panelIdForTab(tab: UnifiedTab): `${string}.${string}` | null {
  return tab.kind === "panel" ? tab.panelId : null;
}

export function hydratePanelReference(
  raw: unknown,
  options: HydratePanelReferenceOptions,
): HydratedPanelReference {
  const availablePanelIds = new Set(options.availablePanelIds);
  const knownPanelIds = new Set(options.knownPanelIds ?? []);
  const migrationAliases = new Map(
    [...(options.migrationAliases ?? [])]
      .map((alias) => [alias.kind, alias] as const),
  );
  const current = readCurrentPanelReference(raw);
  const migrated = current === null ? readMigratablePanelTab(raw, migrationAliases) : null;

  if (current === null && migrated === null) {
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
      migrationKind: null,
      state: undefined,
      raw,
      recovery: recoveryFor("malformed", null),
    };
  }

  const reference = current ?? {
    schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
    instanceId: migrated!.id,
    panelId: migrated!.panelId,
    label: migrated!.label,
    migrationKind: migrated!.kind,
  };
  const source = current === null ? "migrated" : "current";
  const status = availablePanelIds.has(reference.panelId) ? "available" : "unavailable";
  const unavailableReason = knownPanelIds.has(reference.panelId) ? "disabled" : "unknown";

  return {
    status,
    source,
    instanceId: reference.instanceId,
    panelId: reference.panelId,
    label: reference.label,
    migrationKind: reference.migrationKind ?? null,
    state: reference.state,
    raw,
    recovery: status === "available" ? null : recoveryFor(unavailableReason, reference.panelId),
  };
}
