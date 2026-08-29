import { Component, lazy, Suspense, useMemo } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ContributionId,
  ModuleActivationContext,
  ModuleActivationId,
  ModuleId,
  PanelContribution,
  ProjectActionSurfaceHost,
  ProjectActionSurfacePosition,
  ProjectLayoutSlot,
  ProjectRef,
  ProjectSurfaceAction,
  SettingsContribution,
  SettingsSlot,
} from "@shipctl/module-api";

import { MODULE_HOST_SERVICES } from "./moduleHostServices.ts";
import type {
  CanvasProjectLayoutSurface,
  CanvasProjectNavigationSurface,
  CanvasSidebarSurface,
} from "./canvasSurfaceCatalog.ts";
import { useAcceptedWorkspaceContributionRuntime } from "./AcceptedWorkspaceContributionRuntime.tsx";
import {
  activeWorkspaceContributionEntries,
  canvasSurfaceComponentKey,
  currentCanvasSurfaceActivation,
  currentModuleActivation,
} from "./acceptedWorkspaceContributionEntries.ts";
import { useModuleProjectActions } from "./projectActions.ts";

class ModuleSurfaceBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("Module surface crashed:", error, info.componentStack);
    }
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function ProjectLayoutSurface({
  contribution,
  project,
  moduleActivations,
}: {
  readonly contribution: CanvasProjectLayoutSurface;
  readonly project: ProjectRef;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}) {
  const Surface = useMemo(() => lazy(contribution.load), [contribution]);
  const activation = currentCanvasSurfaceActivation(contribution, moduleActivations);
  if (activation === undefined) return null;
  return (
    <ModuleSurfaceBoundary>
      <Suspense fallback={null}>
        <Surface
          project={project}
          activation={activation}
          services={MODULE_HOST_SERVICES}
        />
      </Suspense>
    </ModuleSurfaceBoundary>
  );
}

export function ModuleProjectLayoutSurfaces({
  project,
  slot = "workspace.trailing",
}: {
  readonly project: ProjectRef;
  readonly slot?: ProjectLayoutSlot;
}) {
  const { catalog, moduleActivations } = useAcceptedWorkspaceContributionRuntime();
  const contributions = catalog.canvasSurfaceCatalog.projectLayout(slot);
  return contributions.map((contribution) => (
    <ProjectLayoutSurface
      key={canvasSurfaceComponentKey(contribution)}
      contribution={contribution}
      project={project}
      moduleActivations={moduleActivations}
    />
  ));
}

export function ModuleProjectActionSurface({
  action,
  moduleId,
  activationId,
  project,
  position,
  close,
  host,
}: {
  readonly action: ProjectSurfaceAction;
  readonly moduleId: ModuleId;
  readonly activationId: ModuleActivationId;
  readonly project: ProjectRef;
  readonly position: ProjectActionSurfacePosition;
  readonly close: () => void;
  readonly host: ProjectActionSurfaceHost;
}) {
  const { moduleActivations } = useAcceptedWorkspaceContributionRuntime();
  const Surface = useMemo(() => lazy(action.surface.load), [action]);
  const activation = currentModuleActivation(moduleId, activationId, moduleActivations);
  if (activation === undefined) return null;
  return createPortal(
    <ModuleSurfaceBoundary key={`${activationId}:${action.id}:${position.x}:${position.y}`}>
      <Suspense fallback={null}>
        <Surface
          project={project}
          position={position}
          close={close}
          host={host}
          activation={activation}
          services={MODULE_HOST_SERVICES}
        />
      </Suspense>
    </ModuleSurfaceBoundary>,
    document.body,
  );
}

/** Project action state is an accepted-runtime concern, not a canvas port. */
export function useAcceptedModuleProjectActions(project: ProjectRef) {
  const { catalog, moduleActivations } = useAcceptedWorkspaceContributionRuntime();
  return useModuleProjectActions(project, moduleActivations, catalog.projectActions());
}

function ProjectNavigationSurface({
  contribution,
  project,
  activePanelId,
  activePanelProjectPath,
  onOpenPanel,
  moduleActivations,
}: {
  readonly contribution: CanvasProjectNavigationSurface;
  readonly project: ProjectRef;
  readonly activePanelId: ContributionId | null;
  readonly activePanelProjectPath: string | null;
  readonly onOpenPanel: (panel: PanelContribution) => void | Promise<void>;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}) {
  const Surface = useMemo(() => lazy(contribution.load), [contribution]);
  const activation = currentCanvasSurfaceActivation(contribution, moduleActivations);
  if (activation === undefined) return null;
  const panel = contribution.panel;
  const active = contribution.panelId === activePanelId
    && (panel.scope === "global" || activePanelProjectPath === project.path);

  return (
    <ModuleSurfaceBoundary>
      <Suspense fallback={null}>
        <Surface
          project={project}
          active={active}
          open={() => { void onOpenPanel(panel); }}
          services={MODULE_HOST_SERVICES}
        />
      </Suspense>
    </ModuleSurfaceBoundary>
  );
}

export function ModuleProjectNavigationSurfaces({
  project,
  activePanelId,
  activePanelProjectPath,
  onOpenPanel,
}: {
  readonly project: ProjectRef;
  readonly activePanelId: ContributionId | null;
  readonly activePanelProjectPath: string | null;
  readonly onOpenPanel: (panel: PanelContribution) => void | Promise<void>;
}) {
  const { catalog, moduleActivations } = useAcceptedWorkspaceContributionRuntime();
  const contributions = catalog.canvasSurfaceCatalog.projectNavigation();
  return contributions.map((contribution) => (
    <ProjectNavigationSurface
      key={canvasSurfaceComponentKey(contribution)}
      contribution={contribution}
      project={project}
      activePanelId={activePanelId}
      activePanelProjectPath={activePanelProjectPath}
      onOpenPanel={onOpenPanel}
      moduleActivations={moduleActivations}
    />
  ));
}

function SidebarSurface({
  contribution,
  onToggleGlobalSurface,
  moduleActivations,
}: {
  readonly contribution: CanvasSidebarSurface;
  readonly onToggleGlobalSurface: (surfaceId: ContributionId) => void;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}) {
  const Surface = useMemo(() => lazy(contribution.load), [contribution]);
  const activation = currentCanvasSurfaceActivation(contribution, moduleActivations);
  if (activation === undefined) return null;
  return (
    <ModuleSurfaceBoundary>
      <Suspense fallback={null}>
        <Surface
          open={() => onToggleGlobalSurface(contribution.surfaceId)}
          services={MODULE_HOST_SERVICES}
        />
      </Suspense>
    </ModuleSurfaceBoundary>
  );
}

export function ModuleSidebarSurfaces({
  onToggleGlobalSurface,
  hiddenSurfaceIds,
}: {
  readonly onToggleGlobalSurface: (surfaceId: ContributionId) => void;
  readonly hiddenSurfaceIds?: ReadonlySet<ContributionId>;
}) {
  const { catalog, moduleActivations } = useAcceptedWorkspaceContributionRuntime();
  const contributions = catalog.canvasSurfaceCatalog.sidebar().filter(
    (contribution) => !hiddenSurfaceIds?.has(contribution.surfaceId),
  );
  return contributions.map((contribution) => (
    <SidebarSurface
      key={canvasSurfaceComponentKey(contribution)}
      contribution={contribution}
      onToggleGlobalSurface={onToggleGlobalSurface}
      moduleActivations={moduleActivations}
    />
  ));
}

function SettingsSurface({
  contribution,
  projectPaths,
}: {
  readonly contribution: SettingsContribution;
  readonly projectPaths: readonly string[];
}) {
  const Surface = useMemo(() => lazy(contribution.load), [contribution]);
  return (
    <ModuleSurfaceBoundary>
      <Suspense fallback={null}>
        <Surface projectPaths={projectPaths} services={MODULE_HOST_SERVICES} />
      </Suspense>
    </ModuleSurfaceBoundary>
  );
}

export function ModuleSettingsSurfaces({
  projectPaths,
  slot = "projects.after",
}: {
  readonly projectPaths: readonly string[];
  readonly slot?: SettingsSlot;
}) {
  const { catalog, moduleActivations } = useAcceptedWorkspaceContributionRuntime();
  return activeWorkspaceContributionEntries(catalog.settings(), moduleActivations)
    .flatMap(({ contribution, owner }) => {
      if ((contribution.slot ?? "projects.after") !== slot) {
        return [];
      }
      return [
        <SettingsSurface
          key={`${owner.activationId}:${contribution.id}`}
          contribution={contribution}
          projectPaths={projectPaths}
        />,
      ];
    });
}
