import { Component, lazy, Suspense, useMemo, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type {
  ContributionId,
  GlobalSurfaceContribution,
  ModuleActivationContext,
  ModuleActivationId,
  ModuleHostServices,
  ModuleId,
} from "@shipctl/module-api";

import {
  canvasSurfaceComponentKey,
  currentCanvasSurfaceActivation,
} from "./acceptedWorkspaceContributionEntries.ts";

type ActivationOwnedGlobalSurfaceContribution = GlobalSurfaceContribution & {
  readonly ownerActivationId?: ModuleActivationId;
};

interface GlobalSurfaceHostProps {
  readonly contribution: ActivationOwnedGlobalSurfaceContribution | undefined;
  readonly surfaceId: ContributionId;
  readonly close: () => void;
  readonly projectPaths: readonly string[];
  readonly services: ModuleHostServices;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}

class GlobalSurfaceBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: (error: Error) => ReactNode },
  { readonly error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("Global surface contribution crashed:", error, info.componentStack);
    }
  }

  render() {
    return this.state.error === null
      ? this.props.children
      : this.props.fallback(this.state.error);
  }
}

function GlobalSurfaceUnavailable({
  title,
  description,
  retry,
  close,
}: {
  readonly title: string;
  readonly description: string;
  readonly retry: () => void;
  readonly close: () => void;
}) {
  return (
    <div className="panel-host__unavailable" role="alert">
      <strong>{title}</strong>
      <span>{description}</span>
      <div className="panel-host__actions">
        <button className="btn-primary" onClick={retry}>Retry</button>
        <button className="btn-ghost" onClick={close}>Close</button>
      </div>
    </div>
  );
}

export default function GlobalSurfaceHost({
  contribution,
  surfaceId,
  close,
  projectPaths,
  services,
  moduleActivations,
}: GlobalSurfaceHostProps) {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const Surface = useMemo(
    () => contribution ? lazy(contribution.load) : null,
    [contribution, loadAttempt],
  );
  const retry = () => setLoadAttempt((attempt) => attempt + 1);

  if (!contribution || !Surface) {
    return (
      <GlobalSurfaceUnavailable
        title="Surface unavailable"
        description={`${surfaceId} is not registered in this build.`}
        retry={retry}
        close={close}
      />
    );
  }

  const unavailable = contribution.unavailable ?? {
    title: "Surface unavailable",
    description: `${contribution.id} could not be loaded.`,
  };
  const activation = currentCanvasSurfaceActivation(contribution, moduleActivations);

  if (!activation || activation.disposed) {
    return (
      <GlobalSurfaceUnavailable
        title={unavailable.title}
        description={`${contribution.moduleId} is not active.`}
        retry={retry}
        close={close}
      />
    );
  }

  return (
    <GlobalSurfaceBoundary
      key={`${canvasSurfaceComponentKey(contribution)}:${loadAttempt}`}
      fallback={(error) => (
        <GlobalSurfaceUnavailable
          title={unavailable.title}
          description={`${unavailable.description} ${error.message}`}
          retry={retry}
          close={close}
        />
      )}
    >
      <Suspense fallback={<div className="terminal-empty">Loading surface…</div>}>
        <Surface
          close={close}
          projectPaths={projectPaths}
          activation={activation}
          services={services}
        />
      </Suspense>
    </GlobalSurfaceBoundary>
  );
}
