export const MIN_STANDARD_WORKSPACE_NAVIGATION_WIDTH = 1;

export function resizedStandardWorkspaceNavigationWidth(
  startWidth: number,
  startPointerX: number,
  currentPointerX: number,
  availableWidth: number,
): number {
  const maximumWidth = Math.max(
    MIN_STANDARD_WORKSPACE_NAVIGATION_WIDTH,
    Math.floor(availableWidth),
  );
  const requestedWidth = Math.round(startWidth + currentPointerX - startPointerX);
  return Math.min(
    maximumWidth,
    Math.max(MIN_STANDARD_WORKSPACE_NAVIGATION_WIDTH, requestedWidth),
  );
}
