import { Component, lazy, Suspense, useMemo } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type {
  ProjectNavigationContribution,
  ProjectRef,
  SettingsContribution,
} from "@shep/module-api";

import { panelTabId } from "../../lib/types";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { MODULE_HOST_SERVICES } from "./moduleHostServices";
import {
  moduleProjectNavigationContributions,
  moduleSettingsContributions,
} from "./moduleComposition";
import { tabKindForPanelId } from "./panelPersistence";

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
  const legacyKind = tabKindForPanelId(contribution.panelId);
  const active = legacyKind !== null && activeTabId === panelTabId(legacyKind);

  return (
    <ModuleSurfaceBoundary>
      <Suspense fallback={null}>
        <Surface
          project={project}
          active={active}
          open={() => {
            if (legacyKind) useTerminalStore.getState().addPanelTab(legacyKind);
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
