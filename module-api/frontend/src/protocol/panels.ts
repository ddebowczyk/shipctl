export type ModuleId = string;
export type ContributionId = `${string}.${string}`;

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly groupId?: string | null;
}

export interface PanelIconDescriptor {
  readonly name: string;
  readonly label?: string;
}

export interface PanelUnavailableMetadata {
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string;
}
