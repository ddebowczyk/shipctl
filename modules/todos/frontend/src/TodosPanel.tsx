import { Fragment, useState, useSyncExternalStore } from "react";
import { projectDocumentsService, type ModulePanelProps } from "@shipctl/module-api";
import {
  LayoutList,
  ListTodo,
  Sparkles,
  Square,
  SquareCheckBig,
  SquareKanban,
} from "lucide-react";

import { renderInlineMarkdown } from "./inlineMarkdown";
import { useTodoStore } from "./store";
import type { TodoFile, TodoItem, TodoSection } from "./types";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Board model ──────────────────────────────────────────────────────

interface Card {
  item: TodoItem;
  children: TodoItem[];
}

interface Column {
  section: TodoSection;
  cards: Card[];
}

export function isDoneColumn(title: string): boolean {
  // Strip leading emoji/symbols so "✅ Done" matches like "Done".
  const plain = title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return /^(done|complete|completed|shipped|finished)\b/i.test(plain);
}

function pushItem(cards: Card[], item: TodoItem) {
  const last = cards[cards.length - 1];
  if (last && item.indent > last.item.indent) {
    last.children.push(item);
  } else {
    cards.push({ item, children: [] });
  }
}

/** Sections-as-columns: pick the heading level that owns the items (most
 *  common wins) and make every heading at that level a column. Items under
 *  deeper headings roll up into the enclosing column; items above the first
 *  column land in a read-only inbox. */
export function buildColumns(file: TodoFile): { columns: Column[]; inbox: Card[] } {
  const ownerCounts = new Map<number, number>();
  for (const item of file.items) {
    if (item.sectionLine == null) continue;
    const section = file.sections.find((s) => s.line === item.sectionLine);
    if (section) ownerCounts.set(section.level, (ownerCounts.get(section.level) ?? 0) + 1);
  }
  let pool = [...ownerCounts.entries()];
  if (pool.length === 0) {
    const levels = new Map<number, number>();
    for (const s of file.sections) levels.set(s.level, (levels.get(s.level) ?? 0) + 1);
    pool = [...levels.entries()].filter(([level]) => level > 1);
    if (pool.length === 0) pool = [...levels.entries()];
  }
  if (pool.length === 0) {
    const inbox: Card[] = [];
    for (const item of file.items) pushItem(inbox, item);
    return { columns: [], inbox };
  }
  pool.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const columnLevel = pool[0][0];

  const columns: Column[] = file.sections
    .filter((s) => s.level === columnLevel)
    .map((section) => ({ section, cards: [] }));
  const inbox: Card[] = [];

  for (const item of file.items) {
    let owner: Column | undefined;
    if (item.sectionLine != null) {
      for (const column of columns) {
        if (column.section.line <= item.sectionLine) owner = column;
        else break;
      }
    }
    if (owner) pushItem(owner.cards, item);
    else pushItem(inbox, item);
  }
  return { columns, inbox };
}

// ── List view ────────────────────────────────────────────────────────

interface TodoListViewProps {
  file: TodoFile;
  showFileLabel: boolean;
  onToggle: (file: TodoFile, item: TodoItem) => void;
}

function TodoListView({ file, showFileLabel, onToggle }: TodoListViewProps) {
  let previousSection: string | null | undefined;

  return (
    <div className="todos-panel__file">
      {showFileLabel && <div className="todos-panel__file-label">{file.relativePath}</div>}
      {file.items.map((item) => {
        const sectionChanged = item.section !== previousSection;
        previousSection = item.section;
        return (
          <Fragment key={`${item.line}-${item.text}`}>
            {sectionChanged && item.section && (
              <div className="todos-panel__section">{item.section}</div>
            )}
            <button
              className={`todos-panel__item ${item.checked ? "todos-panel__item--done" : ""}`}
              style={item.indent > 0 ? { paddingLeft: 10 + item.indent * 8 } : undefined}
              onClick={() => onToggle(file, item)}
            >
              <span className="todos-panel__item-box">
                {item.checked ? <SquareCheckBig size={15} /> : <Square size={15} />}
              </span>
              <span className="todos-panel__item-text">{renderInlineMarkdown(item.text)}</span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

// ── Board view ───────────────────────────────────────────────────────

interface TodoBoardViewProps {
  file: TodoFile;
  showFileLabel: boolean;
  columns: Column[];
  inbox: Card[];
  onToggle: (file: TodoFile, item: TodoItem) => void;
  onMove: (file: TodoFile, item: TodoItem, target: TodoSection) => void;
}

function TodoBoardView({ file, showFileLabel, columns, inbox, onToggle, onMove }: TodoBoardViewProps) {
  const [dragging, setDragging] = useState<TodoItem | null>(null);
  const [dragOverLine, setDragOverLine] = useState<number | null>(null);

  const renderCard = (card: Card, draggable: boolean) => (
    <div
      key={`${card.item.line}-${card.item.text}`}
      className={`todos-board__card ${card.item.checked ? "todos-board__card--done" : ""}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.item.text);
        setDragging(card.item);
      }}
      onDragEnd={() => {
        setDragging(null);
        setDragOverLine(null);
      }}
    >
      <button className="todos-board__card-main" onClick={() => onToggle(file, card.item)}>
        <span className="todos-panel__item-box">
          {card.item.checked ? <SquareCheckBig size={14} /> : <Square size={14} />}
        </span>
        <span className="todos-board__card-text">{renderInlineMarkdown(card.item.text)}</span>
      </button>
      {card.children.map((child) => (
        <button
          key={`${child.line}-${child.text}`}
          className={`todos-board__child ${child.checked ? "todos-board__child--done" : ""}`}
          onClick={() => onToggle(file, child)}
        >
          <span className="todos-panel__item-box">
            {child.checked ? <SquareCheckBig size={12} /> : <Square size={12} />}
          </span>
          <span className="todos-board__card-text">{renderInlineMarkdown(child.text)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="todos-board__file">
      {showFileLabel && <div className="todos-panel__file-label">{file.relativePath}</div>}
      <div className="todos-board">
        {inbox.length > 0 && (
          <div className="todos-board__column">
            <div className="todos-board__column-title">
              Inbox
              <span className="todos-board__count">{inbox.length}</span>
            </div>
            <div className="todos-board__cards">{inbox.map((c) => renderCard(c, false))}</div>
          </div>
        )}
        {columns.map((column) => {
          const isTarget =
            dragging != null &&
            dragOverLine === column.section.line &&
            dragging.sectionLine !== column.section.line;
          return (
            <div
              key={column.section.line}
              className={`todos-board__column ${isTarget ? "todos-board__column--drop" : ""}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverLine(column.section.line);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setDragOverLine((line) => (line === column.section.line ? null : line));
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverLine(null);
                if (dragging && dragging.sectionLine !== column.section.line) {
                  onMove(file, dragging, column.section);
                }
                setDragging(null);
              }}
            >
              <div className="todos-board__column-title">
                {column.section.title}
                <span className="todos-board__count">{column.cards.length}</span>
              </div>
              <div className="todos-board__cards">
                {column.cards.map((c) => renderCard(c, true))}
                {column.cards.length === 0 && <div className="todos-board__empty-col" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────

export default function TodosPanel({ project, services, activation }: ModulePanelProps) {
  const activeProjectPath = project?.path ?? null;
  const documents = activation.services.require(projectDocumentsService);
  const files = useTodoStore((s) =>
    activeProjectPath ? s.projectTodos[activeProjectPath] : undefined,
  );
  const skills = useSyncExternalStore(
    services.skills.subscribe,
    services.skills.getSnapshot,
  );
  // Unknown (not yet checked) counts as present so the button doesn't flash.
  const projectSkills = activeProjectPath ? skills.byProject[activeProjectPath] : undefined;
  const skillPresent = projectSkills
    ? projectSkills.some((skill) => skill.name === "shipctl-todos" && skill.installed)
    : true;
  const settings = useSyncExternalStore(
    services.settings.subscribe,
    services.settings.getSnapshot,
  );
  const todoFileStyle = settings.values.todoFileStyle === "list" ? "list" : "kanban";
  const pushNotice = services.notices.push;
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [installingSkill, setInstallingSkill] = useState(false);
  const [viewPref, setViewPref] = useState<"board" | "list" | null>(null);

  if (!activeProjectPath) {
    return (
      <div className="todos-panel todos-panel--empty">
        Select a project to see its to-dos
      </div>
    );
  }

  const todoFiles = files ?? [];
  const allItems = todoFiles.flatMap((f) => f.items);
  const openCount = allItems.filter((i) => !i.checked).length;
  const doneCount = allItems.length - openCount;
  const hasFile = todoFiles.length > 0;

  const boards = todoFiles.map((file) => ({ file, ...buildColumns(file) }));
  const boardPossible = boards.some((b) => b.columns.length >= 2);
  const view = viewPref ?? (boardPossible ? "board" : "list");

  // New items land in the first non-done column of the primary file's board.
  const primaryBoard = boards[0];
  const addTarget =
    view === "board" && primaryBoard
      ? primaryBoard.columns.find((c) => !isDoneColumn(c.section.title)) ?? null
      : null;

  const handleToggle = (file: TodoFile, item: TodoItem) => {
    useTodoStore
      .getState()
      .toggleItem(documents, file, item.line, item.text, !item.checked)
      .catch((error) => {
        pushNotice({
          tone: "error",
          title: "Couldn't update to-do",
          message: getErrorMessage(error),
        });
      });
  };

  const handleMove = (file: TodoFile, item: TodoItem, target: TodoSection) => {
    useTodoStore
      .getState()
      .moveItem(
        documents,
        file,
        item.line,
        item.text,
        target.line,
        isDoneColumn(target.title),
      )
      .catch((error) => {
        pushNotice({
          tone: "error",
          title: "Couldn't move to-do",
          message: getErrorMessage(error),
        });
      });
  };

  const handleAdd = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      // New items go to the first discovered file. The document service
      // creates TODO.md at the project root when the list is still absent.
      await useTodoStore
        .getState()
        .addItem(
          documents,
          activeProjectPath,
          todoFiles[0] ?? null,
          text,
          addTarget?.section.line ?? null,
          todoFileStyle === "kanban",
        );
      setDraft("");
    } catch (error) {
      pushNotice({
        tone: "error",
        title: "Couldn't add to-do",
        message: getErrorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleInstallSkill = async () => {
    if (installingSkill) return;
    setInstallingSkill(true);
    try {
      await services.skills.install(activeProjectPath, "shipctl-todos");
      pushNotice({
        tone: "info",
        title: "Agent skill added",
        message:
          "Wrote .agents/skills/shipctl-todos and linked it from .claude/skills — Claude Code, Codex, and OpenCode will now keep TODO.md in board format.",
      });
    } catch (error) {
      pushNotice({
        tone: "error",
        title: "Couldn't add agent skill",
        message: getErrorMessage(error),
      });
    } finally {
      setInstallingSkill(false);
    }
  };

  return (
    <div className="todos-panel">
      <div className="todos-panel__header">
        <div className="todos-panel__title-wrap">
          <span className="shrink-0"><ListTodo size={15} /></span>
          <div className="todos-panel__title-block">
            <div className="todos-panel__title">To-dos</div>
            <div className="todos-panel__subtitle">
              {hasFile
                ? `${openCount} open · ${doneCount} done · ${todoFiles
                    .map((f) => f.relativePath)
                    .join(", ")}`
                : "No TODO.md in this project"}
            </div>
          </div>
        </div>
        <div className="todos-panel__header-actions">
          {!skillPresent && (
            <button
              className="glass-button todos-panel__skill-btn"
              disabled={installingSkill}
              title="Teach your coding agents (Claude Code, Codex, OpenCode) to keep TODO.md as a kanban board. Writes a skill to .agents/skills/shipctl-todos with a pointer from .claude/skills."
              onClick={() => void handleInstallSkill()}
            >
              <Sparkles size={13} />
              {installingSkill ? "Adding..." : "Add agent skill"}
            </button>
          )}
          {boardPossible && (
            <div className="todos-panel__view-toggle">
              <button
                className={`todos-panel__view-btn ${view === "board" ? "todos-panel__view-btn--active" : ""}`}
                title="Board view"
                onClick={() => setViewPref("board")}
              >
                <SquareKanban size={14} />
              </button>
              <button
                className={`todos-panel__view-btn ${view === "list" ? "todos-panel__view-btn--active" : ""}`}
                title="List view"
                onClick={() => setViewPref("list")}
              >
                <LayoutList size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="todos-panel__list">
        {!hasFile && (
          <div className="todos-panel__empty">
            Add a to-do below and Shipctl will create a <code>TODO.md</code> at the
            project root
            {todoFileStyle === "kanban" ? " with Backlog / In Progress / Done columns" : ""}.
            It&apos;s a plain markdown checklist — you and your coding agents share
            the same file, and edits from either side show up here.
          </div>
        )}
        {boards.map(({ file, columns, inbox }) =>
          view === "board" && columns.length >= 2 ? (
            <TodoBoardView
              key={file.relativePath}
              file={file}
              showFileLabel={todoFiles.length > 1}
              columns={columns}
              inbox={inbox}
              onToggle={handleToggle}
              onMove={handleMove}
            />
          ) : (
            <TodoListView
              key={file.relativePath}
              file={file}
              showFileLabel={todoFiles.length > 1}
              onToggle={handleToggle}
            />
          ),
        )}
        {hasFile && allItems.length === 0 && (
          <div className="todos-panel__empty">This list is empty — add a to-do below.</div>
        )}
      </div>

      <form
        className="todos-panel__add"
        onSubmit={(e) => {
          e.preventDefault();
          void handleAdd();
        }}
      >
        <input
          className="todos-panel__add-input"
          type="text"
          placeholder={
            addTarget
              ? `Add to ${addTarget.section.title}`
              : hasFile
                ? "Add a to-do"
                : "Add a to-do (creates TODO.md)"
          }
          value={draft}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="glass-button todos-panel__add-btn"
          disabled={!draft.trim() || saving}
        >
          {saving ? "Adding..." : "Add"}
        </button>
      </form>
    </div>
  );
}
