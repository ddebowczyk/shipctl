import {
  WORKSPACE_CATALOG_SCHEMA_VERSION,
  type CommandContribution,
  type ContributionId,
  type GlobalNavigationContribution,
  type GlobalSurfaceContribution,
  type ModuleActivationContext,
  type ModuleActivationId,
  type ModuleId,
  type PanelContribution,
  type ProjectActionContribution,
  type ProjectLayoutContribution,
  type ProjectNavigationContribution,
  type SettingsContribution,
  type ShipctlModule,
  type SidebarContribution,
  type WorkspaceCatalogSnapshot,
  type WorkspaceViewDefinition,
} from "@shipctl/module-api";
import { parseWorkspaceCatalogSnapshot } from "@shipctl/core/workspace";

import {
  CanvasSurfaceCatalog,
  type CanvasGlobalSurface,
  type CanvasPanelSurface,
} from "./canvasSurfaceCatalog.ts";

/**
 * The typed, activation-owned contribution families that affect host UI.
 * Their executable React loaders remain private to this host catalog.
 */
export type WorkspaceContributionFamily =
  | "command"
  | "panel"
  | "global-surface"
  | "global-navigation"
  | "sidebar"
  | "project-navigation"
  | "project-layout"
  | "project-action"
  | "settings";

type ContributionFields = Pick<
  ShipctlModule,
  | "commands"
  | "panels"
  | "globalSurfaces"
  | "globalNavigation"
  | "sidebar"
  | "projectNavigation"
  | "projectLayout"
  | "projectActions"
  | "settings"
>;

interface OwnedContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
}

export interface WorkspaceContributionSource extends ContributionFields {
  readonly moduleId: ModuleId;
  readonly activation: ModuleActivationContext;
}

export interface WorkspaceContributionCatalogInput {
  /** The already accepted runtime revision. This is not a discovery input. */
  readonly registryRevision: number;
  /** Activated feature definitions from one complete runtime family. */
  readonly modules: readonly ShipctlModule[];
  readonly activationContextsByModule: ReadonlyMap<ModuleId, ModuleActivationContext>;
  /** Direct artifact registrations from an already accepted runtime family. */
  readonly runtimeContributions?: readonly WorkspaceContributionSource[];
  /** Host-owned built-ins, such as Settings, use the same ownership rule. */
  readonly hostContributions?: readonly WorkspaceContributionSource[];
}

export interface WorkspaceContributionOwner {
  readonly moduleId: ModuleId;
  readonly activationId: ModuleActivationId;
}

export interface ActivatedWorkspaceContribution<T extends OwnedContribution> {
  readonly contribution: T;
  readonly owner: WorkspaceContributionOwner;
}

export interface WorkspaceContributionRecord {
  readonly family: WorkspaceContributionFamily;
  readonly id: ContributionId;
  readonly ownerModuleId: ModuleId;
  readonly ownerActivationId: ModuleActivationId;
  readonly targetId?: ContributionId;
  readonly viewTypeId?: string;
}

export interface WorkspaceContributionCatalogInspection {
  readonly registryRevision: number;
  readonly workspaceCatalogRevision: number;
  readonly contributions: readonly WorkspaceContributionRecord[];
  readonly viewDefinitions: readonly WorkspaceViewDefinition[];
}

/** A private renderer lookup. It is intentionally absent from the public workspace catalog. */
export type WorkspaceRendererEntry =
  | {
    readonly kind: "panel";
    readonly definition: WorkspaceViewDefinition;
    readonly surface: CanvasPanelSurface;
  }
  | {
    readonly kind: "global-surface";
    readonly definition: WorkspaceViewDefinition;
    readonly surface: CanvasGlobalSurface;
  };

export class WorkspaceContributionCatalogError extends Error {
  readonly code:
    | "invalid-registry-revision"
    | "duplicate-module-id"
    | "missing-activation"
    | "disposed-activation"
    | "activation-owner-mismatch"
    | "contribution-owner-mismatch"
    | "duplicate-contribution"
    | "missing-target"
    | "target-owner-mismatch"
    | "invalid-panel-cardinality"
    | "duplicate-workspace-view"
    | "invalid-canvas-contribution";
  readonly contributionId?: ContributionId;

  constructor(
    code: WorkspaceContributionCatalogError["code"],
    message: string,
    contributionId?: ContributionId,
  ) {
    super(message);
    this.name = "WorkspaceContributionCatalogError";
    this.code = code;
    this.contributionId = contributionId;
  }
}

interface CatalogState {
  readonly registryRevision: number;
  readonly canvasSurfaceCatalog: CanvasSurfaceCatalog;
  readonly workspaceCatalog: WorkspaceCatalogSnapshot;
  readonly records: readonly WorkspaceContributionRecord[];
  readonly renderers: ReadonlyMap<string, WorkspaceRendererEntry>;
  readonly commands: readonly ActivatedWorkspaceContribution<CommandContribution>[];
  readonly panels: readonly ActivatedWorkspaceContribution<PanelContribution>[];
  readonly globalSurfaces: readonly ActivatedWorkspaceContribution<GlobalSurfaceContribution>[];
  readonly globalNavigation: readonly ActivatedWorkspaceContribution<GlobalNavigationContribution>[];
  readonly sidebar: readonly ActivatedWorkspaceContribution<SidebarContribution>[];
  readonly projectNavigation: readonly ActivatedWorkspaceContribution<ProjectNavigationContribution>[];
  readonly projectLayout: readonly ActivatedWorkspaceContribution<ProjectLayoutContribution>[];
  readonly projectActions: readonly ActivatedWorkspaceContribution<ProjectActionContribution>[];
  readonly settings: readonly ActivatedWorkspaceContribution<SettingsContribution>[];
}

function fail(
  code: WorkspaceContributionCatalogError["code"],
  message: string,
  contributionId?: ContributionId,
): never {
  throw new WorkspaceContributionCatalogError(code, message, contributionId);
}

function compareById(
  left: { readonly id: ContributionId; readonly order?: number },
  right: { readonly id: ContributionId; readonly order?: number },
): number {
  return (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id);
}

function assertRegistryRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid-registry-revision", "Workspace contribution registry revision is invalid.");
  }
}

function freezeOwner(source: WorkspaceContributionSource): WorkspaceContributionOwner {
  return Object.freeze({
    moduleId: source.moduleId,
    activationId: source.activation.identity.activationId,
  });
}

function sourceModule(source: WorkspaceContributionSource): ShipctlModule {
  return {
    id: source.moduleId,
    version: "host-contribution-source",
    commands: source.commands,
    panels: source.panels,
    globalSurfaces: source.globalSurfaces,
    globalNavigation: source.globalNavigation,
    sidebar: source.sidebar,
    projectNavigation: source.projectNavigation,
    projectLayout: source.projectLayout,
    projectActions: source.projectActions,
    settings: source.settings,
  };
}

function sourcesFor(input: WorkspaceContributionCatalogInput): readonly WorkspaceContributionSource[] {
  assertRegistryRevision(input.registryRevision);
  const sources: WorkspaceContributionSource[] = [];
  const moduleIds = new Set<ModuleId>();

  for (const module of input.modules) {
    if (moduleIds.has(module.id)) {
      fail("duplicate-module-id", `Runtime family contains module ${module.id} more than once.`);
    }
    moduleIds.add(module.id);
    const activation = input.activationContextsByModule.get(module.id);
    if (activation === undefined) {
      fail("missing-activation", `Module ${module.id} has no active context.`);
    }
    sources.push({
      moduleId: module.id,
      activation,
      ...module,
    });
  }

  for (const source of input.runtimeContributions ?? []) {
    if (moduleIds.has(source.moduleId)) {
      fail("duplicate-module-id", `Contribution source ${source.moduleId} appears more than once.`);
    }
    moduleIds.add(source.moduleId);
    sources.push(source);
  }

  for (const source of input.hostContributions ?? []) {
    if (moduleIds.has(source.moduleId)) {
      fail("duplicate-module-id", `Contribution source ${source.moduleId} appears more than once.`);
    }
    moduleIds.add(source.moduleId);
    sources.push(source);
  }

  for (const source of sources) {
    if (source.activation.disposed) {
      fail("disposed-activation", `Contribution source ${source.moduleId} is already disposed.`);
    }
    if (source.activation.identity.moduleId !== source.moduleId) {
      fail(
        "activation-owner-mismatch",
        `Contribution source ${source.moduleId} has an activation owned by ${source.activation.identity.moduleId}.`,
      );
    }
  }
  return Object.freeze([...sources]);
}

function collect<T extends OwnedContribution>(
  sources: readonly WorkspaceContributionSource[],
  family: WorkspaceContributionFamily,
  select: (source: WorkspaceContributionSource) => readonly T[] | undefined,
): readonly ActivatedWorkspaceContribution<T>[] {
  const entries: ActivatedWorkspaceContribution<T>[] = [];
  const seen = new Set<ContributionId>();
  for (const source of sources) {
    const owner = freezeOwner(source);
    for (const contribution of select(source) ?? []) {
      if (contribution.moduleId !== source.moduleId) {
        fail(
          "contribution-owner-mismatch",
          `${family} contribution ${contribution.id} belongs to ${contribution.moduleId}, not ${source.moduleId}.`,
          contribution.id,
        );
      }
      if (seen.has(contribution.id)) {
        fail(
          "duplicate-contribution",
          `${family} contribution ${contribution.id} appears more than once.`,
          contribution.id,
        );
      }
      seen.add(contribution.id);
      entries.push(Object.freeze({
        contribution: Object.freeze({ ...contribution }),
        owner,
      }));
    }
  }
  return Object.freeze(entries.sort((left, right) => compareById(left.contribution, right.contribution)));
}

function byContributionId<T extends OwnedContribution>(
  entries: readonly ActivatedWorkspaceContribution<T>[],
): ReadonlyMap<ContributionId, ActivatedWorkspaceContribution<T>> {
  return new Map(entries.map((entry) => [entry.contribution.id, entry]));
}

function assertOwnedTarget<T extends OwnedContribution>(
  family: WorkspaceContributionFamily,
  entry: ActivatedWorkspaceContribution<T>,
  targetId: ContributionId,
  targets: ReadonlyMap<ContributionId, ActivatedWorkspaceContribution<OwnedContribution>>,
): void {
  const target = targets.get(targetId);
  if (target === undefined) {
    fail(
      "missing-target",
      `${family} contribution ${entry.contribution.id} targets missing contribution ${targetId}.`,
      entry.contribution.id,
    );
  }
  if (
    target.owner.moduleId !== entry.owner.moduleId
    || target.owner.activationId !== entry.owner.activationId
  ) {
    fail(
      "target-owner-mismatch",
      `${family} contribution ${entry.contribution.id} targets another activation.`,
      entry.contribution.id,
    );
  }
}

function panelDefinition(
  entry: ActivatedWorkspaceContribution<PanelContribution>,
): WorkspaceViewDefinition {
  const panel = entry.contribution;
  if (
    (panel.scope === "global" && panel.singleton === "per-project")
    || (panel.scope === "project" && panel.singleton === "global")
  ) {
    fail(
      "invalid-panel-cardinality",
      `Panel ${panel.id} has a cardinality incompatible with its ${panel.scope} scope.`,
      panel.id,
    );
  }
  return Object.freeze({
    viewTypeId: panel.id,
    ownerModuleId: entry.owner.moduleId,
    ownerActivationId: entry.owner.activationId,
    label: panel.label,
    scope: panel.scope,
    cardinality: panel.singleton === false
      ? "multiple"
      : panel.singleton === "per-project"
        ? "one-per-resource"
        : "singleton",
    // Existing panel close removes the tab. Keeping that behavior avoids a
    // hidden second panel state during the compatibility migration.
    closeBehavior: "dispose",
    requiredCapabilityIds: Object.freeze([...(panel.requiredCapabilities ?? [])]),
    placement: Object.freeze({ defaultRegion: "primary", allowSplit: true }),
    presentation: Object.freeze({
      loaderId: `shipctl.canvas.panel.${panel.id}`,
      exportName: "default",
    }),
    // A panel migration alias is an old tab-persistence kind (for example,
    // `git`), not a semantic workspace view ID. It must be converted at the
    // legacy persistence boundary rather than admitted as a false workspace
    // alias here.
    migrationAliases: Object.freeze([]),
  });
}

function globalSurfaceDefinition(
  entry: ActivatedWorkspaceContribution<GlobalSurfaceContribution>,
  label: string,
): WorkspaceViewDefinition {
  const surface = entry.contribution;
  return Object.freeze({
    viewTypeId: surface.id,
    ownerModuleId: entry.owner.moduleId,
    ownerActivationId: entry.owner.activationId,
    label,
    scope: "global",
    cardinality: "singleton",
    closeBehavior: "hide",
    requiredCapabilityIds: Object.freeze([]),
    placement: Object.freeze({ defaultRegion: "primary", allowSplit: true }),
    presentation: Object.freeze({
      loaderId: `shipctl.canvas.global-surface.${surface.id}`,
      exportName: "default",
    }),
    migrationAliases: Object.freeze([]),
  });
}

function contributionRecord(
  family: WorkspaceContributionFamily,
  entry: ActivatedWorkspaceContribution<OwnedContribution>,
  options: { readonly targetId?: ContributionId; readonly viewTypeId?: string } = {},
): WorkspaceContributionRecord {
  return Object.freeze({
    family,
    id: entry.contribution.id,
    ownerModuleId: entry.owner.moduleId,
    ownerActivationId: entry.owner.activationId,
    ...(options.targetId === undefined ? {} : { targetId: options.targetId }),
    ...(options.viewTypeId === undefined ? {} : { viewTypeId: options.viewTypeId }),
  });
}

function viewLabelBySurface(
  navigation: readonly ActivatedWorkspaceContribution<GlobalNavigationContribution>[],
): ReadonlyMap<ContributionId, string> {
  const labels = new Map<ContributionId, string>();
  for (const item of navigation) {
    if (!labels.has(item.contribution.surfaceId)) {
      labels.set(item.contribution.surfaceId, item.contribution.label);
    }
  }
  return labels;
}

/**
 * Compiles one already accepted runtime family into two deliberately separate
 * products: a data-only WorkspaceCatalogSnapshot and private renderer ports.
 * It never activates, loads, or authorizes module code.
 */
export class WorkspaceContributionCatalog {
  readonly #state: CatalogState;

  private constructor(state: CatalogState) {
    this.#state = state;
  }

  static create(input: WorkspaceContributionCatalogInput): WorkspaceContributionCatalog {
    const sources = sourcesFor(input);
    const commands = collect(sources, "command", (source) => source.commands);
    const panels = collect(sources, "panel", (source) => source.panels);
    const globalSurfaces = collect(sources, "global-surface", (source) => source.globalSurfaces);
    const globalNavigation = collect(sources, "global-navigation", (source) => source.globalNavigation);
    const sidebar = collect(sources, "sidebar", (source) => source.sidebar);
    const projectNavigation = collect(sources, "project-navigation", (source) => source.projectNavigation);
    const projectLayout = collect(sources, "project-layout", (source) => source.projectLayout);
    const projectActions = collect(sources, "project-action", (source) => source.projectActions);
    const settings = collect(sources, "settings", (source) => source.settings);

    const panelsById = byContributionId(panels);
    const surfacesById = byContributionId(globalSurfaces);
    for (const entry of globalNavigation) {
      assertOwnedTarget("global-navigation", entry, entry.contribution.surfaceId, surfacesById);
    }
    for (const entry of sidebar) {
      assertOwnedTarget("sidebar", entry, entry.contribution.surfaceId, surfacesById);
    }
    for (const entry of projectNavigation) {
      assertOwnedTarget("project-navigation", entry, entry.contribution.panelId, panelsById);
    }

    let canvasSurfaceCatalog: CanvasSurfaceCatalog;
    try {
      canvasSurfaceCatalog = CanvasSurfaceCatalog.create({
        modules: sources.map(sourceModule),
        activationContextsByModule: new Map(
          sources.map((source) => [source.moduleId, source.activation]),
        ),
      });
    } catch (error) {
      fail(
        "invalid-canvas-contribution",
        error instanceof Error ? error.message : "Canvas contribution validation failed.",
      );
    }

    const definitionsById = new Map<string, WorkspaceViewDefinition>();
    const renderers = new Map<string, WorkspaceRendererEntry>();
    const labelsBySurface = viewLabelBySurface(globalNavigation);
    for (const surface of canvasSurfaceCatalog.panels()) {
      const entry = panelsById.get(surface.id);
      if (entry === undefined) {
        fail("invalid-canvas-contribution", `Canvas panel ${surface.id} has no accepted owner.`, surface.id);
      }
      const definition = panelDefinition(entry);
      if (definitionsById.has(definition.viewTypeId)) {
        fail("duplicate-workspace-view", `Workspace view ${definition.viewTypeId} appears more than once.`, surface.id);
      }
      definitionsById.set(definition.viewTypeId, definition);
      renderers.set(definition.viewTypeId, Object.freeze({ kind: "panel", definition, surface }));
    }
    for (const surface of canvasSurfaceCatalog.globalSurfaces()) {
      const entry = surfacesById.get(surface.id);
      if (entry === undefined) {
        fail("invalid-canvas-contribution", `Canvas surface ${surface.id} has no accepted owner.`, surface.id);
      }
      const definition = globalSurfaceDefinition(entry, labelsBySurface.get(surface.id) ?? surface.id);
      if (definitionsById.has(definition.viewTypeId)) {
        fail("duplicate-workspace-view", `Workspace view ${definition.viewTypeId} appears more than once.`, surface.id);
      }
      definitionsById.set(definition.viewTypeId, definition);
      renderers.set(definition.viewTypeId, Object.freeze({ kind: "global-surface", definition, surface }));
    }

    const workspaceCatalog = parseWorkspaceCatalogSnapshot({
      schemaVersion: WORKSPACE_CATALOG_SCHEMA_VERSION,
      revision: input.registryRevision,
      definitions: [...definitionsById.values()].sort((left, right) => (
        left.viewTypeId.localeCompare(right.viewTypeId)
      )),
    });
    const records = Object.freeze([
      ...commands.map((entry) => contributionRecord("command", entry)),
      ...panels.map((entry) => contributionRecord("panel", entry, { viewTypeId: entry.contribution.id })),
      ...globalSurfaces.map((entry) => contributionRecord("global-surface", entry, { viewTypeId: entry.contribution.id })),
      ...globalNavigation.map((entry) => contributionRecord("global-navigation", entry, { targetId: entry.contribution.surfaceId })),
      ...sidebar.map((entry) => contributionRecord("sidebar", entry, { targetId: entry.contribution.surfaceId })),
      ...projectNavigation.map((entry) => contributionRecord("project-navigation", entry, { targetId: entry.contribution.panelId })),
      ...projectLayout.map((entry) => contributionRecord("project-layout", entry)),
      ...projectActions.map((entry) => contributionRecord("project-action", entry)),
      ...settings.map((entry) => contributionRecord("settings", entry)),
    ].sort((left, right) => (
      left.family.localeCompare(right.family) || left.id.localeCompare(right.id)
    )));

    return new WorkspaceContributionCatalog({
      registryRevision: input.registryRevision,
      canvasSurfaceCatalog,
      workspaceCatalog,
      records,
      renderers,
      commands,
      panels,
      globalSurfaces,
      globalNavigation,
      sidebar,
      projectNavigation,
      projectLayout,
      projectActions,
      settings,
    });
  }

  get registryRevision(): number {
    return this.#state.registryRevision;
  }

  get canvasSurfaceCatalog(): CanvasSurfaceCatalog {
    return this.#state.canvasSurfaceCatalog;
  }

  workspaceCatalog(): WorkspaceCatalogSnapshot {
    return this.#state.workspaceCatalog;
  }

  renderer(viewTypeId: string): WorkspaceRendererEntry | undefined {
    return this.#state.renderers.get(viewTypeId);
  }

  commands(): readonly ActivatedWorkspaceContribution<CommandContribution>[] {
    return this.#state.commands;
  }

  panels(): readonly ActivatedWorkspaceContribution<PanelContribution>[] {
    return this.#state.panels;
  }

  globalSurfaces(): readonly ActivatedWorkspaceContribution<GlobalSurfaceContribution>[] {
    return this.#state.globalSurfaces;
  }

  globalNavigation(): readonly ActivatedWorkspaceContribution<GlobalNavigationContribution>[] {
    return this.#state.globalNavigation;
  }

  sidebar(): readonly ActivatedWorkspaceContribution<SidebarContribution>[] {
    return this.#state.sidebar;
  }

  projectNavigation(): readonly ActivatedWorkspaceContribution<ProjectNavigationContribution>[] {
    return this.#state.projectNavigation;
  }

  projectLayout(): readonly ActivatedWorkspaceContribution<ProjectLayoutContribution>[] {
    return this.#state.projectLayout;
  }

  projectActions(): readonly ActivatedWorkspaceContribution<ProjectActionContribution>[] {
    return this.#state.projectActions;
  }

  settings(): readonly ActivatedWorkspaceContribution<SettingsContribution>[] {
    return this.#state.settings;
  }

  inspect(): WorkspaceContributionCatalogInspection {
    return Object.freeze({
      registryRevision: this.#state.registryRevision,
      workspaceCatalogRevision: this.#state.workspaceCatalog.revision,
      contributions: this.#state.records,
      viewDefinitions: this.#state.workspaceCatalog.definitions,
    });
  }

  /** Advance registry truth without recreating loaders or contribution ownership. */
  withRegistryRevision(registryRevision: number): WorkspaceContributionCatalog {
    assertRegistryRevision(registryRevision);
    if (registryRevision === this.#state.registryRevision) return this;
    const workspaceCatalog = parseWorkspaceCatalogSnapshot({
      schemaVersion: WORKSPACE_CATALOG_SCHEMA_VERSION,
      revision: registryRevision,
      definitions: this.#state.workspaceCatalog.definitions,
    });
    const definitionsById = new Map(
      workspaceCatalog.definitions.map((definition) => [definition.viewTypeId, definition]),
    );
    const renderers = new Map<string, WorkspaceRendererEntry>();
    for (const [viewTypeId, renderer] of this.#state.renderers) {
      const definition = definitionsById.get(viewTypeId);
      if (definition === undefined) {
        fail("invalid-canvas-contribution", `Renderer ${viewTypeId} has no semantic definition.`);
      }
      renderers.set(viewTypeId, Object.freeze({ ...renderer, definition }) as WorkspaceRendererEntry);
    }
    return new WorkspaceContributionCatalog({
      ...this.#state,
      registryRevision,
      workspaceCatalog,
      renderers,
    });
  }

  /**
   * Add host-owned semantic definitions that have no module loader. The
   * compatibility canvas is one such definition: it is a host renderer, not
   * a feature contribution, but it must be admitted with every runtime
   * catalog so the default workspace has a valid root view.
   */
  withHostWorkspaceDefinitions(
    definitions: readonly WorkspaceViewDefinition[],
  ): WorkspaceContributionCatalog {
    const hostCatalog = parseWorkspaceCatalogSnapshot({
      schemaVersion: WORKSPACE_CATALOG_SCHEMA_VERSION,
      revision: this.#state.registryRevision,
      definitions,
    });
    const definitionsById = new Map(
      this.#state.workspaceCatalog.definitions.map((definition) => [definition.viewTypeId, definition]),
    );
    for (const definition of hostCatalog.definitions) {
      if (definitionsById.has(definition.viewTypeId)) {
        fail(
          "duplicate-workspace-view",
          `Workspace view ${definition.viewTypeId} appears more than once.`,
        definition.viewTypeId as ContributionId,
      );
      }
      definitionsById.set(definition.viewTypeId, definition);
    }
    const workspaceCatalog = parseWorkspaceCatalogSnapshot({
      schemaVersion: WORKSPACE_CATALOG_SCHEMA_VERSION,
      revision: this.#state.registryRevision,
      definitions: [...definitionsById.values()].sort((left, right) => (
        left.viewTypeId.localeCompare(right.viewTypeId)
      )),
    });
    const canonicalDefinitions = new Map(
      workspaceCatalog.definitions.map((definition) => [definition.viewTypeId, definition]),
    );
    const renderers = new Map<string, WorkspaceRendererEntry>();
    for (const [viewTypeId, renderer] of this.#state.renderers) {
      const definition = canonicalDefinitions.get(viewTypeId);
      if (definition === undefined) {
        fail("invalid-canvas-contribution", `Renderer ${viewTypeId} has no semantic definition.`);
      }
      renderers.set(viewTypeId, Object.freeze({ ...renderer, definition }) as WorkspaceRendererEntry);
    }
    return new WorkspaceContributionCatalog({
      ...this.#state,
      workspaceCatalog,
      renderers,
    });
  }
}
