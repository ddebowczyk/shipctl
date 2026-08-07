import type { ModuleProjectDataPort } from "@shep/module-api";

import type { WorkspaceConfig } from "@shep/core/platform";

export interface ProjectDocumentPersistence {
  load(projectPath: string): Promise<WorkspaceConfig>;
  save(projectPath: string, document: WorkspaceConfig): Promise<void>;
  onSaved?(projectPath: string, document: WorkspaceConfig): void;
}

function assertCapabilityId(capabilityId: string) {
  if (!capabilityId.trim()) {
    throw new Error("Project capability ID must not be empty");
  }
  if (capabilityId === "name") {
    throw new Error("Project name is host-owned data");
  }
}

export function createProjectCapabilityDataPort(
  persistence: ProjectDocumentPersistence,
): ModuleProjectDataPort {
  const pendingByProject = new Map<string, Promise<void>>();

  const waitForPending = (projectPath: string) => (
    pendingByProject.get(projectPath)?.catch(() => undefined)
    ?? Promise.resolve()
  );

  return {
    async read(projectPath, capabilityId) {
      assertCapabilityId(capabilityId);
      await waitForPending(projectPath);
      const document = await persistence.load(projectPath);
      return document[capabilityId];
    },

    async replace(projectPath, capabilityId, value) {
      assertCapabilityId(capabilityId);
      const previous = waitForPending(projectPath);
      const operation = previous.then(async () => {
        const document = await persistence.load(projectPath);
        const nextDocument: WorkspaceConfig = {
          ...document,
          [capabilityId]: value,
        };
        await persistence.save(projectPath, nextDocument);
        persistence.onSaved?.(projectPath, nextDocument);
      });

      pendingByProject.set(projectPath, operation);
      try {
        await operation;
      } finally {
        if (pendingByProject.get(projectPath) === operation) {
          pendingByProject.delete(projectPath);
        }
      }
    },
  };
}
