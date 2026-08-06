export interface TodoItem {
  readonly line: number;
  readonly text: string;
  readonly checked: boolean;
  readonly indent: number;
  readonly section: string | null;
  readonly sectionLine: number | null;
}

export interface TodoSection {
  readonly line: number;
  readonly title: string;
  readonly level: number;
}

export interface TodoFile {
  readonly path: string;
  readonly relativePath: string;
  readonly sections: readonly TodoSection[];
  readonly items: readonly TodoItem[];
}

export type TodoFileStyle = "kanban" | "list";
