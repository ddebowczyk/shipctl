import type { TerminalTabData } from "@shep/core/platform";
import ModuleSessionButton from "./ModuleSessionButton.tsx";

interface ModuleSessionListProps {
  sessions: TerminalTabData[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  projectPath: string;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
}

export default function ModuleSessionList({
  sessions,
  activeTabId,
  onSelectTab,
  onCloseTab,
  projectPath,
  onMoveTab,
}: ModuleSessionListProps) {
  return (
    <>
      {sessions.map((tab) => (
        <div key={tab.id}>
          <ModuleSessionButton
            tab={tab}
            isActive={tab.id === activeTabId}
            onClick={() => onSelectTab(tab.id)}
            onClose={() => onCloseTab(tab.id)}
            projectPath={projectPath}
            onMoveTab={onMoveTab}
          />
        </div>
      ))}
    </>
  );
}
