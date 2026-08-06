export interface ModuleSettingsSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
  readonly isSaving: boolean;
  readonly error: string | null;
}

export interface ModuleSettingsPort {
  getSnapshot(): ModuleSettingsSnapshot;
  subscribe(listener: () => void): () => void;
  update(values: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface ModuleSkillRef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly installed: boolean;
}

export interface ModuleSkillsSnapshot {
  readonly byProject: Readonly<Record<string, readonly ModuleSkillRef[]>>;
}

export interface ModuleSkillsPort {
  getSnapshot(): ModuleSkillsSnapshot;
  subscribe(listener: () => void): () => void;
  install(projectPath: string, name: string): Promise<void>;
}

export interface ModuleNotice {
  readonly tone: "info" | "success" | "error";
  readonly title: string;
  readonly message?: string;
}

export interface ModuleNoticesPort {
  push(notice: ModuleNotice): void;
}

export interface ModuleExternalLinksPort {
  open(url: string): Promise<void>;
}

export interface ModuleHostServices {
  readonly settings: ModuleSettingsPort;
  readonly skills: ModuleSkillsPort;
  readonly notices: ModuleNoticesPort;
  readonly externalLinks: ModuleExternalLinksPort;
}
