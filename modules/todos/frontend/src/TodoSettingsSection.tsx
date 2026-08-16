import { useState, useSyncExternalStore } from "react";
import type { SettingsContributionProps } from "@shipctl/module-api";

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
  const showTodos = settings.values.showTodos !== false;
  const fileStyle = settings.values.todoFileStyle === "list" ? "list" : "kanban";

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
            const enabling = !showTodos;
            void services.settings.update({ showTodos: enabling });
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
            onClick={() => void services.settings.update({ todoFileStyle: "kanban" })}
            className={`option-card option-card--compact ${fileStyle === "kanban" ? "selected" : ""}`}
          >
            Kanban board
          </button>
          <button
            onClick={() => void services.settings.update({ todoFileStyle: "list" })}
            className={`option-card option-card--compact ${fileStyle === "list" ? "selected" : ""}`}
          >
            Simple list
          </button>
        </div>
      </div>
    </section>
  );
}
