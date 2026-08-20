import { useState, useSyncExternalStore } from "react";
import type { SettingsContributionProps } from "@shipctl/module-api";

import {
  refreshActiveTodos,
} from "./pluginContributions.ts";
import {
  updateTodoPreferences,
  useTodoPreferencesStore,
} from "./todoPreferences.ts";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function InfoTip({ text }: { readonly text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span
      className="settings-info-tip"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.4 }}>
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="600">i</text>
      </svg>
      {show && <span className="settings-info-tip__bubble">{text}</span>}
    </span>
  );
}

export default function TodoSettingsSection({
  services,
}: SettingsContributionProps) {
  const settings = useSyncExternalStore(
    services.settings.subscribe,
    services.settings.getSnapshot,
  );
  const preferences = useTodoPreferencesStore((state) => state.preferences);
  const legacyPreferences = {
    showTodos: settings.values.showTodos !== false,
    todoFileStyle: settings.values.todoFileStyle === "list" ? "list" : "kanban" as const,
  };
  const showTodos = preferences?.showTodos ?? legacyPreferences.showTodos;
  const fileStyle = preferences?.todoFileStyle ?? legacyPreferences.todoFileStyle;
  const update = (patch: Partial<typeof legacyPreferences>) => {
    const next = { ...(preferences ?? legacyPreferences), ...patch };
    void updateTodoPreferences(next)
      .then(async () => {
        if (next.showTodos) await refreshActiveTodos();
      })
      .catch((error) => {
        services.notices.push({
          tone: "error",
          title: "Couldn't save to-do preferences",
          message: getErrorMessage(error),
        });
      });
  };

  return (
    <section className="settings-section">
      <h2 className="section-label !p-0 settings-section__header">To-dos</h2>

      <div className="settings-row">
        <span className="settings-row__label flex items-center gap-2">
          <span>Project To-dos</span>
          <InfoTip text="Shows a To-dos row in each project that surfaces any TODO.md in the repo as a shared task list for you and your coding agents. Turning this off hides the row and stops scanning for todo files." />
        </span>
        <button
          onClick={() => {
            update({ showTodos: !showTodos });
          }}
          className={`option-card option-card--compact ${showTodos ? "selected" : ""}`}
        >
          {showTodos ? "On" : "Off"}
        </button>
      </div>

      <div className="settings-row !mb-0">
        <span className="settings-row__label flex items-center gap-2">
          <span>New File Style</span>
          <InfoTip text="The shape Shipctl gives a TODO.md it creates for you (when you add your first to-do in a project). Kanban board starts with Backlog / In Progress / Done columns and renders as a board; Simple list is a flat checklist. Existing files are never reformatted." />
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => update({ todoFileStyle: "kanban" })}
            className={`option-card option-card--compact ${fileStyle === "kanban" ? "selected" : ""}`}
          >
            Kanban board
          </button>
          <button
            onClick={() => update({ todoFileStyle: "list" })}
            className={`option-card option-card--compact ${fileStyle === "list" ? "selected" : ""}`}
          >
            Simple list
          </button>
        </div>
      </div>
    </section>
  );
}
