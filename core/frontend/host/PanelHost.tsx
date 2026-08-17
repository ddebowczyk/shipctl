import { Component, lazy, Suspense, useMemo, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type {
  ContributionId,
  ModuleHostServices,
  ModuleActivationContext,
  ModuleActivationId,
  ModuleId,
  PanelContribution,
  ProjectRef,
} from "@shipctl/module-api";

import {
  canvasSurfaceComponentKey,
  currentCanvasSurfaceActivation,
} from "./acceptedWorkspaceContributionEntries.ts";

type ActivationOwnedPanelContribution = PanelContribution & {
  readonly ownerActivationId?: ModuleActivationId;
};

interface PanelHostProps {
  readonly contribution: ActivationOwnedPanelContribution | undefined;
  readonly panelId: ContributionId;
  readonly instanceId: string;
  readonly project: ProjectRef | null;
  readonly visible: boolean;
  readonly close: () => void;
  readonly setTitle: (title: string | null) => void;
  readonly services: ModuleHostServices;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}

interface PanelRenderBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: (error: Error) => ReactNode;
}

interface PanelRenderBoundaryState {
  readonly error: Error | null;
}

class PanelRenderBoundary extends Component<PanelRenderBoundaryProps, PanelRenderBoundaryState> {
  state: PanelRenderBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PanelRenderBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("Panel contribution crashed:", error, info.componentStack);
    }
  }

  render() {
    return this.state.error === null
      ? this.props.children
      : this.props.fallback(this.state.error);
  }
}

function PanelUnavailable({
  title,
  description,
  onRetry,
  onRemove,
}: {
  readonly title: string;
  readonly description: string;
  readonly onRetry: (() => void) | null;
  readonly onRemove: () => void;
}) {
  return (
    <div className="panel-host__unavailable" role="alert">
      <strong>{title}</strong>
      <span>{description}</span>
      <div className="panel-host__actions">
        {onRetry && <button className="btn-primary" onClick={onRetry}>Retry</button>}
        <button className="btn-ghost" onClick={onRemove}>Remove tab</button>
      </div>
    </div>
  );
}

export default function PanelHost({
  contribution,
  panelId,
  instanceId,
  project,
  visible,
  close,
  setTitle,
  services,
  moduleActivations,
}: PanelHostProps) {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const Panel = useMemo(
    () => contribution ? lazy(contribution.load) : null,
    [contribution, loadAttempt],
  );

  if (!contribution || !Panel) {
    return (
      <PanelUnavailable
        title="Panel unavailable"
        description={`${panelId} is not registered in this build.`}
        onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
        onRemove={close}
      />
    );
  }

  const unavailable = contribution.unavailable ?? {
    title: `${contribution.label} unavailable`,
    description: `${contribution.id} could not be loaded.`,
  };
  const activation = currentCanvasSurfaceActivation(contribution, moduleActivations);

  if (!activation || activation.disposed) {
    return (
      <PanelUnavailable
        title={unavailable.title}
        description={`${contribution.moduleId} is not active.`}
        onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
        onRemove={close}
      />
    );
  }

  return (
    <PanelRenderBoundary
      key={`${canvasSurfaceComponentKey(contribution)}:${loadAttempt}`}
      fallback={(error) => (
        <PanelUnavailable
          title={unavailable.title}
          description={`${unavailable.description} ${error.message}`}
          onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
          onRemove={close}
        />
      )}
    >
      <Suspense fallback={<div className="terminal-empty">Loading panel…</div>}>
        <Panel
          instanceId={instanceId}
          project={project}
          visible={visible}
          close={close}
          setTitle={setTitle}
          activation={activation}
          services={services}
        />
      </Suspense>
    </PanelRenderBoundary>
  );
}
