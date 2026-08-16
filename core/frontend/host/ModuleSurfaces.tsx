import { Component, lazy, Suspense, useMemo } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ModuleActivationContext,
  ModuleId,
  ProjectActionSurfaceHost,
  ProjectActionSurfacePosition,
  ProjectRef,
  ProjectSurfaceAction,
  SettingsContribution,
  SettingsSlot,
} from "@shipctl/module-api";

import { contributedPanelTabId } from "@shipctl/core/platform";
import { useTerminalStore } from "@shipctl/core/terminal-host";
import { useUIStore } from "@shipctl/core/shared";
import { MODULE_HOST_SERVICES } from "./moduleHostServices.ts";
import type {
  CanvasProjectLayoutSurface,
  CanvasProjectNavigationSurface,
  CanvasSidebarSurface,
} from "./canvasSurfaceCatalog.ts";
import { moduleSettingsContributions } from "./moduleComposition.ts";

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
  const activation = moduleActivations.get(contribution.moduleId);
  if (!activation || activation.disposed) return null;
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
  contributions,
  project,
  moduleActivations,
}: {
  readonly contributions: readonly CanvasProjectLayoutSurface[];
  readonly project: ProjectRef;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}) {
  return contributions.map((contribution) => (
    <ProjectLayoutSurface
      key={contribution.id}
      contribution={contribution}
      project={project}
      moduleActivations={moduleActivations}
    />
  ));
}

export function ModuleProjectActionSurface({
  action,
  moduleId,
  project,
  position,
  close,
  host,
  moduleActivations,
}: {
  readonly action: ProjectSurfaceAction;
  readonly moduleId: ModuleId;
  readonly project: ProjectRef;
  readonly position: ProjectActionSurfacePosition;
  readonly close: () => void;
  readonly host: ProjectActionSurfaceHost;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}) {
  const Surface = useMemo(() => lazy(action.surface.load), [action]);
  const activation = moduleActivations.get(moduleId);
  if (!activation || activation.disposed) return null;
  return createPortal(
    <ModuleSurfaceBoundary key={`${action.id}:${position.x}:${position.y}`}>
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

function ProjectNavigationSurface({
  contribution,
  project,
  activeTabId,
}: {
  readonly contribution: CanvasProjectNavigationSurface;
  readonly project: ProjectRef;
  readonly activeTabId: string | null;
}) {
  const Surface = useMemo(() => lazy(contribution.load), [contribution]);
  const panel = contribution.panel;
  const instanceId = contributedPanelTabId(contribution.panelId);
  const active = activeTabId === instanceId;

  return (
    <ModuleSurfaceBoundary>
      <Suspense fallback={null}>
        <Surface
          project={project}
          active={active}
          open={() => {
            useTerminalStore.getState().addContributedPanelTab(
              project.path,
              contribution.panelId,
              panel.label,
            );
          }}
          services={MODULE_HOST_SERVICES}
        />
      </Suspense>
    </ModuleSurfaceBoundary>
  );
}

export function ModuleProjectNavigationSurfaces({
  contributions,
  project,
  activeTabId,
}: {
  readonly contributions: readonly CanvasProjectNavigationSurface[];
  readonly project: ProjectRef;
  readonly activeTabId: string | null;
}) {
  return contributions.map((contribution) => (
    <ProjectNavigationSurface
      key={contribution.id}
      contribution={contribution}
      project={project}
      activeTabId={activeTabId}
    />
  ));
}

function SidebarSurface({
  contribution,
}: {
  readonly contribution: CanvasSidebarSurface;
}) {
  const Surface = useMemo(() => lazy(contribution.load), [contribution]);
  return (
    <ModuleSurfaceBoundary>
      <Suspense fallback={null}>
        <Surface
          open={() => useUIStore.getState().toggleGlobalSurface(contribution.surfaceId)}
          services={MODULE_HOST_SERVICES}
        />
      </Suspense>
    </ModuleSurfaceBoundary>
  );
}

export function ModuleSidebarSurfaces({
  contributions,
}: {
  readonly contributions: readonly CanvasSidebarSurface[];
}) {
  return contributions.map((contribution) => (
    <SidebarSurface key={contribution.id} contribution={contribution} />
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
  return moduleSettingsContributions(undefined, slot).map((contribution) => (
    <SettingsSurface
      key={contribution.id}
      contribution={contribution}
      projectPaths={projectPaths}
    />
  ));
}
