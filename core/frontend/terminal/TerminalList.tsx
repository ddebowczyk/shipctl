import type { TerminalTabData } from "@shep/core/platform";
import TerminalItem from "./TerminalItem.tsx";

interface TerminalListProps {
  tabs: TerminalTabData[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  projectPath: string;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
}

export default function TerminalList({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  projectPath,
  onMoveTab,
}: TerminalListProps) {
  return (
    <>
      {tabs.map((tab) => (
        <div key={tab.id}>
          <TerminalItem
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
