type UsageIngestCompletedListener = () => void | Promise<void>;

const listeners = new Set<UsageIngestCompletedListener>();

/**
 * Usage surfaces observe the module's declared completion topic through this
 * local fan-out rather than attaching their own host transport listeners.
 */
export function subscribeUsageIngestCompleted(
  listener: UsageIngestCompletedListener,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function notifyUsageIngestCompleted(): Promise<void> {
  await Promise.allSettled(
    [...listeners].map((listener) => Promise.resolve().then(() => listener())),
  );
}
