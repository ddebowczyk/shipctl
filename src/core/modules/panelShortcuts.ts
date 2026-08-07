interface KeyboardShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export function matchesPanelShortcut(
  event: KeyboardShortcutEvent,
  shortcut: string,
): boolean {
  const key = shortcut.match(/[A-Za-z0-9]$/)?.[0]?.toLowerCase();
  if (!key || event.key.toLowerCase() !== key) return false;
  return event.metaKey === shortcut.includes("⌘")
    && event.shiftKey === shortcut.includes("⇧")
    && !event.altKey;
}
