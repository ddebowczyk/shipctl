import type { ProjectDocument } from "@shipctl/module-api";

import type { TodoFile, TodoItem, TodoSection } from "./types";

interface ParsedCheckbox {
  readonly text: string;
  readonly checked: boolean;
  readonly indent: number;
}

function stripListMarker(trimmed: string): string | null {
  for (const marker of ["- ", "* ", "+ "]) {
    if (trimmed.startsWith(marker)) return trimmed.slice(marker.length);
  }
  const ordered = /^(\d{1,9})[.)] (.*)$/u.exec(trimmed);
  return ordered?.[2] ?? null;
}

function parseCheckboxLine(line: string): ParsedCheckbox | null {
  const trimmed = line.trimStart();
  const indent = line.length - trimmed.length;
  const listContent = stripListMarker(trimmed);
  if (listContent === null) return null;
  const checkbox = /^\[([ xX])\](?: |$)(.*)$/u.exec(listContent.trimStart());
  if (!checkbox) return null;
  return {
    text: checkbox[2].trim(),
    checked: checkbox[1] !== " ",
    indent,
  };
}

function parseHeading(line: string): { readonly level: number; readonly title: string } | null {
  const match = /^(#{1,})(?: |$)(.*)$/u.exec(line.trimStart());
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

function isContinuation(line: string, itemIndent: number): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return false;
  const indent = line.length - trimmed.length;
  return indent > itemIndent && stripListMarker(trimmed) === null;
}

export function parseTodoDocument(document: ProjectDocument): TodoFile {
  const lines = document.contents.split("\n");
  const sections: TodoSection[] = [];
  const items: TodoItem[] = [];
  let current: { readonly title: string; readonly line: number } | null = null;
  let index = 0;
  while (index < lines.length) {
    const heading = parseHeading(lines[index]);
    if (heading) {
      if (heading.title.length > 0) {
        sections.push({ line: index, title: heading.title, level: heading.level });
        current = { title: heading.title, line: index };
      } else {
        current = null;
      }
      index += 1;
      continue;
    }
    const checkbox = parseCheckboxLine(lines[index]);
    if (!checkbox || checkbox.text.length === 0) {
      index += 1;
      continue;
    }
    let text = checkbox.text;
    let span = 1;
    while (
      index + span < lines.length
      && isContinuation(lines[index + span], checkbox.indent)
    ) {
      text += ` ${lines[index + span].trim()}`;
      span += 1;
    }
    items.push({
      line: index,
      text,
      checked: checkbox.checked,
      indent: checkbox.indent,
      section: current?.title ?? null,
      sectionLine: current?.line ?? null,
    });
    index += span;
  }
  return Object.freeze({
    projectId: document.projectId,
    relativePath: document.relativePath,
    revision: document.revision,
    contents: document.contents,
    sections,
    items,
  });
}

function setCheckbox(line: string, checked: boolean): string {
  const checkbox = parseCheckboxLine(line);
  const bracket = line.indexOf("[");
  if (!checkbox || bracket < 0) throw new Error("Malformed to-do line");
  return `${line.slice(0, bracket + 1)}${checked ? "x" : " "}${line.slice(bracket + 2)}`;
}

function requireItem(contents: string, line: number, expectedText: string): TodoItem {
  const parsed = parseTodoDocument({
    projectId: "validation",
    relativePath: "TODO.md",
    revision: "validation" as ProjectDocument["revision"],
    contents,
  });
  const item = parsed.items.find(
    (candidate) => candidate.line === line && candidate.text === expectedText,
  );
  if (!item) throw new Error("To-do list changed on disk — try again");
  return item;
}

export function toggleTodoContents(
  contents: string,
  line: number,
  expectedText: string,
  checked: boolean,
): string {
  requireItem(contents, line, expectedText);
  const lines = contents.split("\n");
  lines[line] = setCheckbox(lines[line], checked);
  return lines.join("\n");
}

function sectionInsertPosition(
  lines: readonly string[],
  headingLine: number,
  level: number,
): number {
  let end = lines.length;
  for (let index = headingLine + 1; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index]);
    if (heading && heading.level <= level) {
      end = index;
      break;
    }
  }
  while (end > headingLine + 1 && lines[end - 1].trim().length === 0) end -= 1;
  return end;
}

export function moveTodoContents(
  contents: string,
  line: number,
  expectedText: string,
  targetSectionLine: number,
  setChecked: boolean | null,
): string {
  const parsed = parseTodoDocument({
    projectId: "validation",
    relativePath: "TODO.md",
    revision: "validation" as ProjectDocument["revision"],
    contents,
  });
  const item = parsed.items.find(
    (candidate) => candidate.line === line && candidate.text === expectedText,
  );
  const target = parsed.sections.find((section) => section.line === targetSectionLine);
  if (!item || !target) throw new Error("To-do list changed on disk — try again");
  const lines = contents.split("\n");
  const laterBoundaries = [
    ...parsed.items
      .filter((candidate) => candidate.line > item.line && candidate.indent <= item.indent)
      .map((candidate) => candidate.line),
    ...parsed.sections
      .filter((section) => section.line > item.line)
      .map((section) => section.line),
    ...lines.flatMap((candidate, index) =>
      index > item.line && candidate.trim().length === 0 ? [index] : []),
  ];
  const blockLimit = laterBoundaries.length > 0 ? Math.min(...laterBoundaries) : lines.length;
  const block = lines.splice(item.line, blockLimit - item.line);
  if (setChecked !== null) block[0] = setCheckbox(block[0], setChecked);

  let removedExtra = 0;
  if (
    item.line > 0
    && item.line < lines.length
    && lines[item.line - 1].trim().length === 0
    && lines[item.line].trim().length === 0
  ) {
    lines.splice(item.line, 1);
    removedExtra = 1;
  }

  let targetLine = target.line;
  if (targetLine > item.line) targetLine -= block.length + removedExtra;
  if (parseHeading(lines[targetLine])?.title !== target.title) {
    throw new Error("To-do list changed on disk — try again");
  }
  const insertAt = sectionInsertPosition(lines, targetLine, target.level);
  if (insertAt === targetLine + 1) {
    lines.splice(insertAt, 0, "", ...block);
    const after = insertAt + 1 + block.length;
    if (after < lines.length && lines[after].trim().length > 0) lines.splice(after, 0, "");
  } else {
    lines.splice(insertAt, 0, ...block);
  }
  return lines.join("\n");
}

export function createTodoContents(text: string, kanban: boolean): string {
  const normalized = text.trim();
  if (normalized.length === 0) throw new Error("To-do text is empty");
  return kanban
    ? `# To-dos\n\n## 📋 Backlog\n\n- [ ] ${normalized}\n\n## 🚧 In Progress\n\n## ✅ Done\n`
    : `# TODO\n\n- [ ] ${normalized}\n`;
}

export function addTodoContents(
  contents: string,
  text: string,
  sectionLine: number | null,
): string {
  const normalized = text.trim();
  if (normalized.length === 0) throw new Error("To-do text is empty");
  const lines = contents.split("\n");
  let insertAt: number;
  if (sectionLine !== null) {
    const parsed = parseTodoDocument({
      projectId: "validation",
      relativePath: "TODO.md",
      revision: "validation" as ProjectDocument["revision"],
      contents,
    });
    const section = parsed.sections.find((candidate) => candidate.line === sectionLine);
    if (!section) throw new Error("To-do list changed on disk — try again");
    insertAt = sectionInsertPosition(lines, section.line, section.level);
    if (insertAt === section.line + 1) {
      lines.splice(insertAt, 0, "");
      insertAt += 1;
    }
  } else {
    let lastCheckbox = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (parseCheckboxLine(lines[index]) !== null) {
        lastCheckbox = index;
        break;
      }
    }
    insertAt = lastCheckbox >= 0 ? lastCheckbox + 1 : lines.length;
  }
  lines.splice(insertAt, 0, `- [ ] ${normalized}`);
  const joined = lines.join("\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}
