// The shared React surface, kept apart from ./index.ts so that node --test can
// import the logic without hitting JSX.
export { default as ContextMenu } from "./ContextMenu.tsx";
export type { ContextMenuItem } from "./ContextMenu.tsx";
export { default as NoticeCenter } from "./NoticeCenter.tsx";
export { default as tabKindMeta, extraActions } from "./tabKindMeta.tsx";
export type { TabKindMeta } from "./tabKindMeta.tsx";
export { default as ActivityIndicator } from "./ActivityIndicator.tsx";
export { default as CollapsibleSection } from "./CollapsibleSection.tsx";
export { default as SidebarSectionToggle } from "./SidebarSectionToggle.tsx";
export { default as GearIcon } from "./GearIcon.tsx";
export { getTabActivityStatus, getAggregateActivityStatus } from "./ActivityIndicator.tsx";
export type { ActivityIndicatorStatus, AggregateActivity } from "./ActivityIndicator.tsx";
