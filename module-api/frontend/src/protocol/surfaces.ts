/** A compact data snapshot that a module contributes for a host project. */
export interface ProjectFacts {
  readonly revision?: {
    readonly label: string;
    readonly state: "clean" | "changed";
  };
  readonly lineage?: {
    readonly parentLabel: string;
  };
}

export type ProjectLayoutSlot = "workspace.trailing";

export interface ProjectActionSurfacePosition {
  readonly x: number;
  readonly y: number;
}

export type SettingsSlot = "projects.after" | "terminal.after";
