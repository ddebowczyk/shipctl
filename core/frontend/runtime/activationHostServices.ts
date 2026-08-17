import type {
  ModuleHostServices,
  ModuleNotice,
  ModuleNoticeOptions,
} from "@shipctl/module-api";

export type ActivationHostServiceState = "candidate" | "accepted" | "retiring" | "disposed";

/** Host mutations are unavailable until the complete candidate graph is public. */
export class ActivationHostServiceUnavailableError extends Error {
  readonly code = "module.runtime.host_service_unavailable";
  readonly operation: string;
  readonly state: ActivationHostServiceState;

  constructor(operation: string, state: ActivationHostServiceState) {
    super(`Host service ${operation} is unavailable while the activation is ${state}`);
    this.name = "ActivationHostServiceUnavailableError";
    this.operation = operation;
    this.state = state;
  }
}

export interface ActivationHostServiceGate {
  readonly services: ModuleHostServices;
  readonly state: ActivationHostServiceState;
  accept(): void;
  beginDisposal(): void;
  dispose(): void;
}

type Cleanup = () => void;

/**
 * A switching facade for one plugin activation.
 *
 * Snapshot reads are safe during preparation. Subscriptions are installed so
 * readiness can be checked, but their callbacks stay private until
 * publication. User-visible mutations are rejected before publication and
 * after disposal. Notices are buffered because activation diagnostics are
 * useful only if the candidate is accepted.
 */
export function createActivationHostServiceGate(
  delegate: ModuleHostServices,
): ActivationHostServiceGate {
  let state: ActivationHostServiceState = "candidate";
  const cleanups = new Set<Cleanup>();
  const pendingNotices: Array<{
    readonly notice: ModuleNotice;
    readonly options?: ModuleNoticeOptions;
  }> = [];

  const requireMutation = (operation: string): void => {
    if (state !== "accepted" && state !== "retiring") {
      throw new ActivationHostServiceUnavailableError(operation, state);
    }
  };
  const track = (cleanup: Cleanup): Cleanup => {
    if (state === "disposed") {
      cleanup();
      return () => undefined;
    }
    cleanups.add(cleanup);
    return () => {
      if (!cleanups.delete(cleanup)) return;
      cleanup();
    };
  };
  const deliver = <Arguments extends readonly unknown[]>(
    listener: (...args: Arguments) => void | Promise<void>,
  ) => (...args: Arguments): void | Promise<void> => {
    if (state !== "accepted") return;
    return listener(...args);
  };

  const services: ModuleHostServices = Object.freeze({
    panels: Object.freeze({
      open: (...args: Parameters<ModuleHostServices["panels"]["open"]>) => {
        requireMutation("panels.open");
        return delegate.panels.open(...args);
      },
      reveal: (...args: Parameters<ModuleHostServices["panels"]["reveal"]>) => {
        requireMutation("panels.reveal");
        return delegate.panels.reveal(...args);
      },
      close: (...args: Parameters<ModuleHostServices["panels"]["close"]>) => {
        requireMutation("panels.close");
        return delegate.panels.close(...args);
      },
    }),
    appearance: Object.freeze({
      getSnapshot: () => delegate.appearance.getSnapshot(),
      subscribe: (listener: Parameters<ModuleHostServices["appearance"]["subscribe"]>[0]) => (
        track(delegate.appearance.subscribe(deliver(listener)))
      ),
    }),
    terminalSessions: Object.freeze({
      getDimensions: () => delegate.terminalSessions.getDimensions(),
      list: () => delegate.terminalSessions.list(),
      launch: async (...args: Parameters<ModuleHostServices["terminalSessions"]["launch"]>) => {
        requireMutation("terminalSessions.launch");
        return delegate.terminalSessions.launch(...args);
      },
      launchManaged: async (
        ...args: Parameters<ModuleHostServices["terminalSessions"]["launchManaged"]>
      ) => {
        requireMutation("terminalSessions.launchManaged");
        return delegate.terminalSessions.launchManaged(...args);
      },
      update: async (...args: Parameters<ModuleHostServices["terminalSessions"]["update"]>) => {
        requireMutation("terminalSessions.update");
        return delegate.terminalSessions.update(...args);
      },
      observe: async (...args: Parameters<ModuleHostServices["terminalSessions"]["observe"]>) => {
        requireMutation("terminalSessions.observe");
        return delegate.terminalSessions.observe(...args);
      },
      stop: async (...args: Parameters<ModuleHostServices["terminalSessions"]["stop"]>) => {
        requireMutation("terminalSessions.stop");
        return delegate.terminalSessions.stop(...args);
      },
      focus: async (...args: Parameters<ModuleHostServices["terminalSessions"]["focus"]>) => {
        requireMutation("terminalSessions.focus");
        return delegate.terminalSessions.focus(...args);
      },
      subscribe: (
        listener: Parameters<ModuleHostServices["terminalSessions"]["subscribe"]>[0],
      ) => track(delegate.terminalSessions.subscribe(deliver(listener))),
    }),
    ...(delegate.terminalPresentation === undefined ? {} : {
      terminalPresentation: Object.freeze({
        getSnapshot: () => delegate.terminalPresentation!.getSnapshot(),
        subscribe: (
          listener: Parameters<NonNullable<ModuleHostServices["terminalPresentation"]>["subscribe"]>[0],
        ) => track(
          delegate.terminalPresentation!.subscribe(deliver(listener)),
        ),
        errorCode: (
          error: Parameters<NonNullable<ModuleHostServices["terminalPresentation"]>["errorCode"]>[0],
        ) => delegate.terminalPresentation!.errorCode(error),
        recordMetric: (
          ...args: Parameters<NonNullable<ModuleHostServices["terminalPresentation"]>["recordMetric"]>
        ) => {
          requireMutation("terminalPresentation.recordMetric");
          return delegate.terminalPresentation!.recordMetric(...args);
        },
        recordDiagnostic: (
          ...args: Parameters<NonNullable<ModuleHostServices["terminalPresentation"]>["recordDiagnostic"]>
        ) => {
          requireMutation("terminalPresentation.recordDiagnostic");
          return delegate.terminalPresentation!.recordDiagnostic(...args);
        },
        notifyBell: (
          ...args: Parameters<NonNullable<ModuleHostServices["terminalPresentation"]>["notifyBell"]>
        ) => {
          requireMutation("terminalPresentation.notifyBell");
          return delegate.terminalPresentation!.notifyBell(...args);
        },
      }),
    }),
    settings: Object.freeze({
      getSnapshot: () => delegate.settings.getSnapshot(),
      subscribe: (listener: Parameters<ModuleHostServices["settings"]["subscribe"]>[0]) => (
        track(delegate.settings.subscribe(deliver(listener)))
      ),
      update: async (...args: Parameters<ModuleHostServices["settings"]["update"]>) => {
        requireMutation("settings.update");
        return delegate.settings.update(...args);
      },
    }),
    skills: Object.freeze({
      getSnapshot: () => delegate.skills.getSnapshot(),
      subscribe: (listener: Parameters<ModuleHostServices["skills"]["subscribe"]>[0]) => (
        track(delegate.skills.subscribe(deliver(listener)))
      ),
      install: async (...args: Parameters<ModuleHostServices["skills"]["install"]>) => {
        requireMutation("skills.install");
        return delegate.skills.install(...args);
      },
    }),
    notices: Object.freeze({
      push: (notice: ModuleNotice, options?: ModuleNoticeOptions) => {
        if (state === "candidate") {
          pendingNotices.push({ notice, ...(options === undefined ? {} : { options }) });
          return;
        }
        requireMutation("notices.push");
        delegate.notices.push(notice, options);
      },
    }),
    externalLinks: Object.freeze({
      open: async (...args: Parameters<ModuleHostServices["externalLinks"]["open"]>) => {
        requireMutation("externalLinks.open");
        return delegate.externalLinks.open(...args);
      },
    }),
  });

  return Object.freeze({
    services,
    get state() { return state; },
    accept() {
      if (state === "accepted") return;
      if (state !== "candidate") {
        throw new ActivationHostServiceUnavailableError("activation.accept", state);
      }
      state = "accepted";
      for (const { notice, options } of pendingNotices.splice(0)) {
        try {
          delegate.notices.push(notice, options);
        } catch (error) {
          if (import.meta.env.DEV) console.error("Could not publish a staged module notice:", error);
        }
      }
    },
    beginDisposal() {
      if (state === "accepted") state = "retiring";
      else if (state === "candidate") state = "disposed";
    },
    dispose() {
      if (state === "disposed" && cleanups.size === 0) return;
      state = "disposed";
      pendingNotices.length = 0;
      for (const cleanup of [...cleanups].reverse()) cleanup();
      cleanups.clear();
    },
  });
}
