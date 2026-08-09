import type {
  TerminalTabData,
  UnifiedTab,
} from "@shipctl/core/platform";
import {
  defaultTerminalViewId,
  type TerminalDescriptor,
  type TerminalId,
} from "./types.ts";
import { terminalSessionFromDescriptor } from "./terminalSessions.ts";

export interface TerminalProjectProjection {
  tabs: UnifiedTab[];
  activeTabId: string | null;
}

export type TerminalProjectProjections = Record<string, TerminalProjectProjection>;

function descriptorProjectPath(descriptor: TerminalDescriptor): string {
  return descriptor.metadata.projectPath ?? descriptor.metadata.cwd;
}

function findTerminal(
  state: TerminalProjectProjections,
  terminalId: TerminalId,
): TerminalTabData | undefined {
  for (const project of Object.values(state)) {
    const tab = project.tabs.find(
      (entry): entry is TerminalTabData =>
        entry.kind === "terminal" && entry.terminalId === terminalId,
    );
    if (tab) return tab;
  }
  return undefined;
}

function withoutTerminal(
  state: TerminalProjectProjections,
  terminalId: TerminalId,
): TerminalProjectProjections {
  const result: TerminalProjectProjections = {};
  for (const [path, project] of Object.entries(state)) {
    const tabs = project.tabs.filter(
      (entry) => entry.kind !== "terminal" || entry.terminalId !== terminalId,
    );
    result[path] = {
      tabs,
      activeTabId: project.activeTabId && tabs.some((tab) => tab.id === project.activeTabId)
        ? project.activeTabId
        : (tabs[0]?.id ?? null),
    };
  }
  return result;
}

/**
 * Upsert one host descriptor into renderer placement state. Older descriptors
 * cannot overwrite a newer projection and the view identity is a pure
 * function of the host terminal identity.
 */
export function upsertTerminalProjection(
  state: TerminalProjectProjections,
  descriptor: TerminalDescriptor,
): TerminalProjectProjections {
  const existing = findTerminal(state, descriptor.id);
  if (existing && existing.terminalRevision > descriptor.revision) return state;

  const projectPath = descriptorProjectPath(descriptor);
  const without = withoutTerminal(state, descriptor.id);
  const project = without[projectPath] ?? { tabs: [], activeTabId: null };
  const moduleSession = terminalSessionFromDescriptor(descriptor);
  const tab: TerminalTabData = {
    id: defaultTerminalViewId(descriptor.id),
    kind: "terminal",
    label: descriptor.metadata.label,
    terminalId: descriptor.id,
    repoPath: descriptor.metadata.cwd,
    commandName: null,
    terminalRevision: descriptor.revision,
    lifecycle: descriptor.lifecycle,
    ...(moduleSession
      ? { moduleSessionId: moduleSession.id }
      : {}),
    ...(moduleSession?.presentation
      ? { modulePresentation: moduleSession.presentation }
      : {}),
  };
  return {
    ...without,
    [projectPath]: {
      tabs: [...project.tabs, tab],
      activeTabId: project.activeTabId ?? tab.id,
    },
  };
}

/**
 * Project a complete host inventory. Host-absent terminal views disappear
 * locally, but this reducer has no host mutation capability and therefore can
 * never close a process.
 */
export function reconcileTerminalProjection(
  state: TerminalProjectProjections,
  descriptors: readonly TerminalDescriptor[],
): TerminalProjectProjections {
  const hostIds = new Set(descriptors.map((descriptor) => descriptor.id));
  let next: TerminalProjectProjections = {};
  for (const [path, project] of Object.entries(state)) {
    const tabs = project.tabs.filter(
      (entry) => entry.kind !== "terminal" || hostIds.has(entry.terminalId),
    );
    next[path] = {
      tabs,
      activeTabId: project.activeTabId && tabs.some((tab) => tab.id === project.activeTabId)
        ? project.activeTabId
        : (tabs[0]?.id ?? null),
    };
  }
  for (const descriptor of descriptors) {
    next = upsertTerminalProjection(next, descriptor);
  }
  return next;
}

export function removeTerminalProjection(
  state: TerminalProjectProjections,
  terminalId: TerminalId,
): TerminalProjectProjections {
  return withoutTerminal(state, terminalId);
}
