import type {
  ContributionId,
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  PanelContribution,
  ProjectLayoutContribution,
  ProjectLayoutSlot,
  ProjectNavigationContribution,
  ShipctlModule,
  SidebarContribution,
} from "@shipctl/module-api";

import type { BuiltinGlobalSurfaceLoaders } from "./builtinGlobalSurfaceAdapters.ts";
import {
  BUILTIN_GLOBAL_NAVIGATION,
  createBuiltinGlobalSurfaceContributions,
} from "./builtinGlobalSurfaceAdapters.ts";
import { ENABLED_MODULES } from "./enabledModules.ts";
import { GlobalSurfaceRegistry } from "./globalSurfaceRegistry.ts";
import { PanelRegistry } from "./panelRegistry.ts";

export type CanvasSurfaceLoadKind =
  | "global-surface"
  | "panel"
  | "project-layout"
  | "project-navigation"
  | "sidebar";

export class CanvasSurfaceCatalogError extends Error {
  readonly code:
    | "duplicate-module-id"
    | "missing-panel"
    | "missing-surface"
    | "module-owner-mismatch"
    | "target-owner-mismatch";
  readonly contributionId: string;

  constructor(
    code: CanvasSurfaceCatalogError["code"],
    contributionId: string,
    message: string,
  ) {
    super(message);
    this.name = "CanvasSurfaceCatalogError";
    this.code = code;
    this.contributionId = contributionId;
  }
}

/** A stable, recoverable error from a module-owned React loading port. */
export class CanvasSurfaceLoadError extends Error {
  readonly code = "canvas.surface.load_failed";
  readonly contributionId: ContributionId;
  readonly surfaceKind: CanvasSurfaceLoadKind;
  readonly cause: unknown;

  constructor(
    surfaceKind: CanvasSurfaceLoadKind,
    contributionId: ContributionId,
    cause: unknown,
  ) {
    super(`Canvas ${surfaceKind} ${contributionId} could not be loaded.`);
    this.name = "CanvasSurfaceLoadError";
    this.surfaceKind = surfaceKind;
    this.contributionId = contributionId;
    this.cause = cause;
  }
}

export interface CanvasPanelSurface extends PanelContribution {
  readonly surfaceKind: "panel";
}

export interface CanvasGlobalSurface extends GlobalSurfaceContribution {
  readonly surfaceKind: "global-surface";
}

export interface CanvasGlobalNavigationSurface extends GlobalNavigationContribution {
  readonly surfaceKind: "global-navigation";
  /** The current host places global visual navigation at the sidebar footer. */
  readonly slot: "sidebar.footer";
}

export interface CanvasSidebarSurface extends SidebarContribution {
  readonly surfaceKind: "sidebar";
  readonly slot: "sidebar.footer";
  readonly target: CanvasGlobalSurface;
}

export interface CanvasProjectNavigationSurface extends ProjectNavigationContribution {
  readonly surfaceKind: "project-navigation";
  readonly slot: "project.navigation";
  readonly panel: CanvasPanelSurface;
}

export interface CanvasProjectLayoutSurface extends ProjectLayoutContribution {
  readonly surfaceKind: "project-layout";
}

export interface CanvasSurfaceCatalogInput {
  /** Build-installed feature modules. Omit one to make its surfaces unavailable. */
  readonly modules?: readonly ShipctlModule[];
  /** Host-owned surfaces, such as Settings. These are not module implementations. */
  readonly builtinGlobalSurfaces?: readonly GlobalSurfaceContribution[];
  readonly builtinGlobalNavigation?: readonly GlobalNavigationContribution[];
}

interface OwnedContribution {
  readonly id: ContributionId;
  readonly moduleId: string;
}

function compareContributions(
  left: { readonly id: ContributionId; readonly order?: number },
  right: { readonly id: ContributionId; readonly order?: number },
): number {
  return (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id);
}

function assertUniqueModuleIds(modules: readonly ShipctlModule[]): void {
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.id)) {
      throw new CanvasSurfaceCatalogError(
        "duplicate-module-id",
        module.id,
        `Canvas module ${module.id} is included more than once.`,
      );
    }
    seen.add(module.id);
  }
}

function assertOwner(
  module: ShipctlModule,
  contribution: OwnedContribution,
): void {
  if (contribution.moduleId !== module.id) {
    throw new CanvasSurfaceCatalogError(
      "module-owner-mismatch",
      contribution.id,
      `Canvas contribution ${contribution.id} belongs to ${contribution.moduleId}, not ${module.id}.`,
    );
  }
}

function contributionEntries<T extends OwnedContribution>(
  modules: readonly ShipctlModule[],
  select: (module: ShipctlModule) => readonly T[] | undefined,
): readonly T[] {
  return modules.flatMap((module) => (select(module) ?? []).map((contribution) => {
    assertOwner(module, contribution);
    return contribution;
  }));
}

function loadPort<T>(
  load: () => Promise<T>,
  surfaceKind: CanvasSurfaceLoadKind,
  contributionId: ContributionId,
): () => Promise<T> {
  return async () => {
    try {
      return await load();
    } catch (error) {
      throw new CanvasSurfaceLoadError(surfaceKind, contributionId, error);
    }
  };
}

function panelSurface(contribution: PanelContribution): CanvasPanelSurface {
  return Object.freeze({
    ...contribution,
    surfaceKind: "panel" as const,
    load: loadPort(contribution.load, "panel", contribution.id),
  });
}

function globalSurface(contribution: GlobalSurfaceContribution): CanvasGlobalSurface {
  return Object.freeze({
    ...contribution,
    surfaceKind: "global-surface" as const,
    load: loadPort(contribution.load, "global-surface", contribution.id),
  });
}

function sidebarSurface(
  contribution: SidebarContribution,
  target: CanvasGlobalSurface,
): CanvasSidebarSurface {
  return Object.freeze({
    ...contribution,
    surfaceKind: "sidebar" as const,
    slot: "sidebar.footer" as const,
    target,
    load: loadPort(contribution.load, "sidebar", contribution.id),
  });
}

function projectNavigationSurface(
  contribution: ProjectNavigationContribution,
  panel: CanvasPanelSurface,
): CanvasProjectNavigationSurface {
  return Object.freeze({
    ...contribution,
    surfaceKind: "project-navigation" as const,
    slot: "project.navigation" as const,
    panel,
    load: loadPort(contribution.load, "project-navigation", contribution.id),
  });
}

function projectLayoutSurface(
  contribution: ProjectLayoutContribution,
): CanvasProjectLayoutSurface {
  return Object.freeze({
    ...contribution,
    surfaceKind: "project-layout" as const,
    load: loadPort(contribution.load, "project-layout", contribution.id),
  });
}

function globalNavigationSurface(
  contribution: GlobalNavigationContribution,
): CanvasGlobalNavigationSurface {
  return Object.freeze({
    ...contribution,
    surfaceKind: "global-navigation" as const,
    slot: "sidebar.footer" as const,
  });
}

function assertTargetOwner(
  source: OwnedContribution,
  target: OwnedContribution,
  targetKind: "panel" | "surface",
): void {
  if (source.moduleId !== target.moduleId) {
    throw new CanvasSurfaceCatalogError(
      "target-owner-mismatch",
      source.id,
      `Canvas contribution ${source.id} and ${targetKind} ${target.id} must have the same module owner.`,
    );
  }
}

/**
 * A host-owned, layout-library-independent view of the static UI profile.
 *
 * It is intentionally a compiler, not an IoC container: callers provide the
 * exact bundled modules and host surfaces, and receive validated stable
 * references for an adapter to place.
 */
export class CanvasSurfaceCatalog {
  readonly #panels: ReadonlyMap<ContributionId, CanvasPanelSurface>;
  readonly #globalSurfaces: ReadonlyMap<ContributionId, CanvasGlobalSurface>;
  readonly #orderedPanels: readonly CanvasPanelSurface[];
  readonly #orderedGlobalSurfaces: readonly CanvasGlobalSurface[];
  readonly #globalNavigation: readonly CanvasGlobalNavigationSurface[];
  readonly #sidebar: readonly CanvasSidebarSurface[];
  readonly #projectNavigation: readonly CanvasProjectNavigationSurface[];
  readonly #projectLayout: readonly CanvasProjectLayoutSurface[];

  private constructor({
    panels,
    globalSurfaces,
    globalNavigation,
    sidebar,
    projectNavigation,
    projectLayout,
  }: {
    readonly panels: readonly CanvasPanelSurface[];
    readonly globalSurfaces: readonly CanvasGlobalSurface[];
    readonly globalNavigation: readonly CanvasGlobalNavigationSurface[];
    readonly sidebar: readonly CanvasSidebarSurface[];
    readonly projectNavigation: readonly CanvasProjectNavigationSurface[];
    readonly projectLayout: readonly CanvasProjectLayoutSurface[];
  }) {
    this.#panels = new Map(panels.map((contribution) => [contribution.id, contribution]));
    this.#globalSurfaces = new Map(
      globalSurfaces.map((contribution) => [contribution.id, contribution]),
    );
    this.#orderedPanels = Object.freeze([...panels].sort(compareContributions));
    this.#orderedGlobalSurfaces = Object.freeze(
      [...globalSurfaces].sort((left, right) => left.id.localeCompare(right.id)),
    );
    this.#globalNavigation = Object.freeze([...globalNavigation].sort(compareContributions));
    this.#sidebar = Object.freeze([...sidebar].sort(compareContributions));
    this.#projectNavigation = Object.freeze([...projectNavigation].sort(compareContributions));
    this.#projectLayout = Object.freeze([...projectLayout].sort(compareContributions));
  }

  static create({
    modules = [],
    builtinGlobalSurfaces = [],
    builtinGlobalNavigation = [],
  }: CanvasSurfaceCatalogInput = {}): CanvasSurfaceCatalog {
    assertUniqueModuleIds(modules);

    const panels = contributionEntries(modules, (module) => module.panels)
      .map(panelSurface);
    const globalSurfaces = [
      ...builtinGlobalSurfaces.map(globalSurface),
      ...contributionEntries(modules, (module) => module.globalSurfaces).map(globalSurface),
    ];
    const globalNavigation = [
      ...builtinGlobalNavigation.map(globalNavigationSurface),
      ...contributionEntries(modules, (module) => module.globalNavigation)
        .map(globalNavigationSurface),
    ];

    // Validate registry identities before resolving cross-reference targets.
    // Otherwise a duplicate could overwrite an entry in a temporary Map and
    // produce a misleading owner error instead of the actionable duplicate ID.
    const panelRegistry = PanelRegistry.create(panels);
    const globalSurfaceRegistry = GlobalSurfaceRegistry.create({
      surfaces: globalSurfaces,
      navigation: globalNavigation,
    });
    const panelById = new Map(
      panelRegistry.list().map((contribution) => [contribution.id, contribution as CanvasPanelSurface]),
    );
    const surfaceById = new Map(
      globalSurfaceRegistry.surfaces().map(
        (contribution) => [contribution.id, contribution as CanvasGlobalSurface],
      ),
    );
    const sidebar = contributionEntries(modules, (module) => module.sidebar)
      .map((contribution) => {
        const target = surfaceById.get(contribution.surfaceId);
        if (!target) {
          throw new CanvasSurfaceCatalogError(
            "missing-surface",
            contribution.id,
            `Canvas sidebar contribution ${contribution.id} targets missing surface ${contribution.surfaceId}.`,
          );
        }
        assertTargetOwner(contribution, target, "surface");
        return sidebarSurface(contribution, target);
      });
    const projectNavigation = contributionEntries(modules, (module) => module.projectNavigation)
      .map((contribution) => {
        const panel = panelById.get(contribution.panelId);
        if (!panel) {
          throw new CanvasSurfaceCatalogError(
            "missing-panel",
            contribution.id,
            `Canvas project navigation contribution ${contribution.id} targets missing panel ${contribution.panelId}.`,
          );
        }
        assertTargetOwner(contribution, panel, "panel");
        return projectNavigationSurface(contribution, panel);
      });
    const projectLayout = contributionEntries(modules, (module) => module.projectLayout)
      .map(projectLayoutSurface);

    return new CanvasSurfaceCatalog({
      panels,
      globalSurfaces,
      globalNavigation,
      sidebar,
      projectNavigation,
      projectLayout,
    });
  }

  panel(id: ContributionId): CanvasPanelSurface | undefined {
    return this.#panels.get(id);
  }

  panels(): readonly CanvasPanelSurface[] {
    return this.#orderedPanels;
  }

  globalSurface(id: ContributionId): CanvasGlobalSurface | undefined {
    return this.#globalSurfaces.get(id);
  }

  globalSurfaces(): readonly CanvasGlobalSurface[] {
    return this.#orderedGlobalSurfaces;
  }

  globalNavigation(): readonly CanvasGlobalNavigationSurface[] {
    return this.#globalNavigation;
  }

  sidebar(): readonly CanvasSidebarSurface[] {
    return this.#sidebar;
  }

  projectNavigation(): readonly CanvasProjectNavigationSurface[] {
    return this.#projectNavigation;
  }

  projectLayout(slot?: ProjectLayoutSlot): readonly CanvasProjectLayoutSurface[] {
    return slot === undefined
      ? this.#projectLayout
      : this.#projectLayout.filter((contribution) => contribution.slot === slot);
  }
}

export function createEnabledCanvasSurfaceCatalog(
  builtinLoaders: BuiltinGlobalSurfaceLoaders,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): CanvasSurfaceCatalog {
  return CanvasSurfaceCatalog.create({
    modules,
    builtinGlobalSurfaces: createBuiltinGlobalSurfaceContributions(builtinLoaders),
    builtinGlobalNavigation: BUILTIN_GLOBAL_NAVIGATION,
  });
}
