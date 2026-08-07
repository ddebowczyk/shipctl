// The terminal capability's React surface, kept apart from its logic entry
// point so that node --test can import the logic without hitting JSX.
export { default as TerminalView } from "./TerminalView.tsx";
export { default as TerminalErrorBoundary } from "./TerminalErrorBoundary.tsx";
export { default as TerminalItem } from "./TerminalItem.tsx";
export { default as TerminalList } from "./TerminalList.tsx";
export { default as AgentSessionList } from "./AgentSessionList.tsx";
export type { AgentSessionItem } from "./AgentSessionList.tsx";
