interface ClosestEventTarget {
  closest?: (selector: string) => Element | null;
}

function isInsideContextMenu(target: EventTarget | null): boolean {
  const candidate = target as ClosestEventTarget | null;
  return candidate?.closest?.(".context-menu") != null;
}

export function dismissContextMenuForPointerTarget(
  target: EventTarget | null,
  onClose: () => void,
): void {
  if (!isInsideContextMenu(target)) onClose();
}
