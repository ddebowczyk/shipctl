import { useMemo } from "react";
import {
  terminalDriverId,
  type TerminalHostDescriptor,
} from "@shipctl/module-api";
import type { TerminalTabData, UnifiedTab } from "@shipctl/core/platform";

import TerminalErrorBoundary from "./TerminalErrorBoundary.tsx";
import { TerminalSlot } from "./TerminalSlot.tsx";
import { TERMINAL_CLIENT_RUNTIME } from "./terminalClientRuntime.ts";
import { useTerminalStore } from "./useTerminalStore.ts";
import { useTerminalPresentationRuntime } from "./TerminalPresentationRuntime.tsx";

const SEMANTIC_TERMINAL_DRIVER_ID = terminalDriverId("semantic-terminal");

export type TerminalStageProjectState = Readonly<Record<string, {
  readonly tabs: readonly UnifiedTab[];
}>>;

export interface TerminalStageSlot {
  readonly key: string;
  readonly tab: TerminalTabData;
  readonly projectPath: string;
  readonly descriptor: TerminalHostDescriptor;
}

function descriptorFor(tab: TerminalTabData): TerminalHostDescriptor {
  const descriptor = TERMINAL_CLIENT_RUNTIME.descriptor(tab.terminalId);
  return {
    id: tab.terminalId,
    driverId: descriptor?.driverId ?? SEMANTIC_TERMINAL_DRIVER_ID,
    lifecycle: descriptor?.lifecycle ?? "starting",
    columns: descriptor?.columns ?? 0,
    rows: descriptor?.rows ?? 0,
    label: descriptor?.metadata.label ?? tab.label,
    projectPath: descriptor?.metadata.projectPath ?? tab.repoPath,
  };
}

export function terminalStageSlotsFor(
  projectState: TerminalStageProjectState,
): readonly TerminalStageSlot[] {
  const slots: TerminalStageSlot[] = [];
  for (const [projectPath, project] of Object.entries(projectState)) {
    for (const tab of project.tabs) {
      if (tab.kind !== "terminal") continue;
      slots.push({
        key: `${tab.terminalId}:${tab.id}`,
        tab,
        projectPath,
        descriptor: descriptorFor(tab),
      });
    }
  }
  return slots.sort((left, right) => (
    left.tab.terminalId.localeCompare(right.tab.terminalId)
      || left.tab.id.localeCompare(right.tab.id)
  ));
}

export function terminalStageSlotVisible(
  slot: TerminalStageSlot,
  {
    visible,
    activeProjectPath,
    activeTabId,
  }: {
    readonly visible: boolean;
    readonly activeProjectPath: string | null;
    readonly activeTabId: string | null;
  },
): boolean {
  return visible
    && slot.projectPath === activeProjectPath
    && slot.tab.id === activeTabId;
}

export interface TerminalStageProps {
  /** Hiding a stage never unmounts a terminal presentation. */
  readonly visible: boolean;
}

/**
 * The single mount-stable terminal region for a workspace frame.
 *
 * Every terminal known to the projection remains in the DOM. Selection only
 * changes CSS visibility, so a semantic view, another terminal, or an
 * adapter transition cannot detach a live terminal renderer.
 */
export function TerminalStage({ visible }: TerminalStageProps) {
  const projectState = useTerminalStore((state) => state.projectState);
  const {
    registry,
    moduleActivations,
    services,
    activeProjectPath,
    activeTabId,
  } = useTerminalPresentationRuntime();
  const slots = useMemo(() => terminalStageSlotsFor(projectState), [projectState]);
  const activeProjectHasTerminal = activeProjectPath !== null && slots.some((slot) => (
    slot.projectPath === activeProjectPath
  ));

  return (
    <div className="terminal-stage" data-terminal-stage="mounted">
      {visible && !activeProjectHasTerminal && (
        <div className="terminal-empty">
          {activeProjectPath ? "Open a session or terminal" : "Select or add a project to begin"}
        </div>
      )}
      {slots.map((slot) => {
        const slotVisible = terminalStageSlotVisible(slot, {
          visible,
          activeProjectPath,
          activeTabId,
        });
        return (
          <div
            key={slot.key}
            className="absolute inset-0"
            data-terminal-slot={slot.tab.terminalId}
            style={{ display: slotVisible ? "block" : "none" }}
          >
            <TerminalErrorBoundary>
              <TerminalSlot
                descriptor={slot.descriptor}
                registry={registry}
                moduleActivations={moduleActivations}
                services={services}
                visible={slotVisible}
              />
            </TerminalErrorBoundary>
          </div>
        );
      })}
    </div>
  );
}
