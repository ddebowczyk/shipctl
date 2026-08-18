import { listen } from "@tauri-apps/api/event";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";

type Unsubscribe = () => void;

function reportDesktopWindowFailure(error: unknown): void {
  if (import.meta.env.DEV) {
    console.error("[shipctl] native window action failed:", error);
  }
}

export function confirmProjectRemoval(projectName: string): Promise<boolean> {
  return ask(
    `Remove "${projectName}" from Shipctl? The files on disk will not be deleted.`,
    { title: "Remove project", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
  );
}

export function confirmGroupRemoval(groupName: string): Promise<boolean> {
  return ask(
    `Remove group "${groupName}"? Projects in this group will become ungrouped.`,
    { title: "Remove group", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
  );
}

export function confirmApplicationQuit(runningSessionCount: number): Promise<boolean> {
  return ask(
    runningSessionCount > 0
      ? `Quit Shipctl and stop ${runningSessionCount} running session${runningSessionCount === 1 ? "" : "s"}?`
      : "Quit Shipctl?",
    { title: "Quit Shipctl", kind: "warning", okLabel: "Quit", cancelLabel: "Cancel" },
  );
}

/** Owns native title-bar window actions without exposing the Tauri window API. */
export function handleTitleBarPrimaryPress(clickCount: number): void {
  const currentWindow = getCurrentWindow();
  const operation = clickCount === 2
    ? currentWindow.toggleMaximize()
    : currentWindow.startDragging();
  void operation.catch(reportDesktopWindowFailure);
}

/** Applies the one native visual treatment owned by Shipctl themes. */
export function applyTransparentWindowEffects(isTransparent: boolean): void {
  const currentWindow = getCurrentWindow();
  const operation = isTransparent
    ? currentWindow.setEffects({
        effects: [Effect.HudWindow],
        state: EffectState.Active,
      })
    : currentWindow.clearEffects();
  void operation.catch(reportDesktopWindowFailure);
}

/** Subscribes to the native quit request using the shell's semantic count. */
export function observeQuitRequests(
  receive: (runningSessionCount: number) => void | Promise<void>,
): Promise<Unsubscribe> {
  return listen<number>("quit-requested", (event) => {
    void receive(event.payload);
  });
}

/** Subscribes to stable native menu command identifiers. */
export function observeNativeMenuCommands(
  receive: (commandId: string) => void,
): Promise<Unsubscribe> {
  return listen<string>("menu-event", (event) => {
    receive(event.payload);
  });
}
