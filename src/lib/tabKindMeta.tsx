import { Terminal, SquareTerminal, List, PanelsTopLeft, ExternalLink } from "lucide-react";
import type { TabKind } from "./types";

export interface TabKindMeta {
  label: string;
  icon: (size: number) => React.ReactNode;
  shortcut?: string;
}

const meta: Record<TabKind, TabKindMeta> = {
  assistant: {
    label: "Agent",
    icon: (size) => <SquareTerminal size={size} />,
    shortcut: "⇧⌘T",
  },
  terminal: {
    label: "Terminal",
    icon: (size) => <Terminal size={size} />,
    shortcut: "⌘T",
  },
  commands: {
    label: "Commands",
    icon: (size) => <List size={size} />,
    shortcut: "⇧⌘C",
  },
  launcher: {
    label: "New Agent",
    icon: (size) => <SquareTerminal size={size} />,
  },
  panel: {
    label: "Panel",
    icon: (size) => <PanelsTopLeft size={size} />,
  },
};

/** Extra actions shown in the + menu but not tab kinds */
export const extraActions = {
  openInEditor: {
    label: "Open in Editor",
    icon: (size: number) => <ExternalLink size={size} />,
    shortcut: "⌘E",
  },
} as const;

export default meta;
