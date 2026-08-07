import { Component, lazy, Suspense, useMemo } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ProjectActionSurfaceHost,
  ProjectActionSurfacePosition,
  ProjectLayoutContribution,
  ProjectLayoutSlot,
  ProjectNavigationContribution,
  ProjectRef,
  ProjectSurfaceAction,
  SettingsContribution,
} from "@shep/module-api";

import { contributedPanelTabId } from "../../lib/types";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { MODULE_HOST_SERVICES } from "./moduleHostServices";
import {
  enabledProjectLayoutContributions,
  modulePanelContributions,
  moduleProjectNavigationContributions,
  moduleSettingsContributions,
} from "./moduleComposition";

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
}: {
  readonly contribution: ProjectLayoutContribution;
  readonly project: ProjectRef;
}) {
  const Surface = useMemo(() => lazy(contribution.load), [contribution]);
  return (
    <ModuleSurfaceBoundary>
      <Suspense fallback={null}>
        <Surface project={project} services={MODULE_HOST_SERVICES} />
      </Suspense>
    </ModuleSurfaceBoundary>
  );
}

export function ModuleProjectLayoutSurfaces({
  slot,
  project,
}: {
  readonly slot: ProjectLayoutSlot;
  readonly project: ProjectRef;
}) {
  return enabledProjectLayoutContributions()
    .filter((contribution) => contribution.slot === slot)
    .map((contribution) => (
      <ProjectLayoutSurface
        key={contribution.id}
        contribution={contribution}
        project={project}
      />
    ));
}

export function ModuleProjectActionSurface({
  action,
  project,
  position,
  close,
  host,
}: {
  readonly action: ProjectSurfaceAction;
  readonly project: ProjectRef;
  readonly position: ProjectActionSurfacePosition;
  readonly close: () => void;
  readonly host: ProjectActionSurfaceHost;
}) {
  const Surface = useMemo(() => lazy(action.surface.load), [action]);
  return createPortal(
    <ModuleSurfaceBoundary key={`${action.id}:${position.x}:${position.y}`}>
      <Suspense fallback={null}>
        <Surface
          project={project}
          position={position}
          close={close}
          host={host}
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
  readonly contribution: ProjectNavigationContribution;
  readonly project: ProjectRef;
  readonly activeTabId: string | null;
}) {
  const Surface = useMemo(() => lazy(contribution.load), [contribution]);
  const panel = modulePanelContributions().find(({ id }) => id === contribution.panelId);
  if (!panel) return null;
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
  project,
  activeTabId,
}: {
  readonly project: ProjectRef;
  readonly activeTabId: string | null;
}) {
  return moduleProjectNavigationContributions().map((contribution) => (
    <ProjectNavigationSurface
      key={contribution.id}
      contribution={contribution}
      project={project}
      activeTabId={activeTabId}
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
}: {
  readonly projectPaths: readonly string[];
}) {
  return moduleSettingsContributions().map((contribution) => (
    <SettingsSurface
      key={contribution.id}
      contribution={contribution}
      projectPaths={projectPaths}
    />
  ));
}
