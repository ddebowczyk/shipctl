import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { useUIStore } from "../useUIStore.ts";

beforeEach(() => {
  useUIStore.setState({
    leftSidebarVisible: true,
    rightSidebarVisible: true,
    usagePanelVisible: true,
    trailingStripVisible: true,
    projectsPanelVisible: true,
  });
});

test("sidebar visibility switches remain independent", () => {
  useUIStore.getState().toggleLeftSidebar();
  assert.equal(useUIStore.getState().leftSidebarVisible, false);
  assert.equal(useUIStore.getState().rightSidebarVisible, true);

  useUIStore.getState().toggleRightSidebar();
  assert.equal(useUIStore.getState().leftSidebarVisible, false);
  assert.equal(useUIStore.getState().rightSidebarVisible, false);
});

test("panel visibility switches remain independent", () => {
  useUIStore.getState().toggleUsagePanel();
  useUIStore.getState().toggleTrailingStrip();

  assert.equal(useUIStore.getState().usagePanelVisible, false);
  assert.equal(useUIStore.getState().trailingStripVisible, false);
  assert.equal(useUIStore.getState().projectsPanelVisible, true);

  useUIStore.getState().toggleProjectsPanel();
  assert.equal(useUIStore.getState().projectsPanelVisible, false);
});
