import type { ModuleGlobalDataPort } from "@shipctl/module-api";

export interface GlobalCapabilityPersistence {
  read(capabilityId: string): Promise<unknown>;
  replace(capabilityId: string, value: unknown): Promise<void>;
}

function assertCapabilityId(capabilityId: string) {
  if (!capabilityId.trim()) {
    throw new Error("Global capability ID must not be empty");
  }
}

export function createGlobalCapabilityDataPort(
  persistence: GlobalCapabilityPersistence,
): ModuleGlobalDataPort {
  let pending: Promise<void> = Promise.resolve();

  const waitForPending = () => pending.catch(() => undefined);

  return {
    async read(capabilityId) {
      assertCapabilityId(capabilityId);
      await waitForPending();
      return persistence.read(capabilityId);
    },

    async replace(capabilityId, value) {
      assertCapabilityId(capabilityId);
      const operation = waitForPending().then(() =>
        persistence.replace(capabilityId, value));
      pending = operation;
      await operation;
    },
  };
}
