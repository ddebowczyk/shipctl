import assert from "node:assert/strict";
import test from "node:test";

import {
  hydratePanelReference,
  PANEL_REFERENCE_SCHEMA_VERSION,
  toPersistedPanelReference,
} from "../../src/core/modules/panelPersistence.ts";

const migrationAliases = [
  { kind: "commands", panelId: "core.commands", label: "Commands" },
  { kind: "launcher", panelId: "assistants.launcher", label: "New Agent" },
] as const;
const allModulePanels = migrationAliases.map(({ panelId }) => panelId);
const gitPanel = { kind: "git", panelId: "core.git", label: "Files" };
const allAvailablePanels = [...allModulePanels, gitPanel.panelId];

test("pre-registry panel tabs migrate to equivalent stable references", () => {
  for (const { kind, panelId } of migrationAliases) {
    const raw = { id: `panel-${kind}`, kind, label: `Custom ${kind}` };
    const result = hydratePanelReference(raw, {
      availablePanelIds: allModulePanels,
      migrationAliases,
    });

    assert.equal(result.status, "available");
    assert.equal(result.source, "migrated");
    assert.equal(result.instanceId, raw.id);
    assert.equal(result.panelId, panelId);
    assert.equal(result.label, raw.label);
    assert.equal(result.migrationKind, kind);
    assert.equal(result.raw, raw);
    assert.equal(result.recovery, null);
  }
});

test("current references preserve opaque module state", () => {
  const state = { selectedFile: "src/main.ts", futureField: [1, 2, 3] };
  const raw = toPersistedPanelReference({
    instanceId: "panel-git",
    panelId: "core.git",
    label: "Files",
    migrationKind: "git",
    state,
  });
  const result = hydratePanelReference(raw, {
    availablePanelIds: allAvailablePanels,
    migrationAliases: [gitPanel],
  });

  assert.equal(raw.schemaVersion, PANEL_REFERENCE_SCHEMA_VERSION);
  assert.equal(result.status, "available");
  assert.equal(result.source, "current");
  assert.equal(result.state, state);
});

test("module migration metadata restores pre-module Git tabs", () => {
  const raw = { id: "panel-git", kind: "git", label: "Files" };
  const result = hydratePanelReference(raw, {
    availablePanelIds: allAvailablePanels,
    migrationAliases: [gitPanel],
  });

  assert.equal(result.status, "available");
  assert.equal(result.source, "migrated");
  assert.equal(result.panelId, "core.git");
});

test("unknown panel IDs remain retryable and removable", () => {
  const raw = {
    schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
    instanceId: "timeline-1",
    panelId: "example.timeline",
    label: "Timeline",
    state: { cursor: 7 },
  };
  const result = hydratePanelReference(raw, { availablePanelIds: allModulePanels });

  assert.equal(result.status, "unavailable");
  assert.equal(result.recovery?.reason, "unknown");
  assert.equal(result.recovery?.canRetry, true);
  assert.equal(result.recovery?.canRemove, true);
  assert.equal(result.state, raw.state);
  assert.equal(result.raw, raw);
});

test("known but disabled panels are distinguished from unknown panels", () => {
  const raw = {
    schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
    instanceId: "timeline-1",
    panelId: "example.timeline",
    label: "Timeline",
  };
  const result = hydratePanelReference(raw, {
    availablePanelIds: ["core.git"],
    knownPanelIds: [...allModulePanels, "example.timeline"],
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.recovery?.reason, "disabled");
  assert.equal(result.recovery?.canRetry, true);
  assert.equal(result.recovery?.canRemove, true);
});

test("malformed entries never throw and retain the original value", () => {
  const fixtures: unknown[] = [
    null,
    "panel",
    { id: "broken", kind: "future", label: "Future" },
    { schemaVersion: 999, instanceId: "old", panelId: "core.git", label: "Files" },
    { schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION, instanceId: "bad", panelId: "not-namespaced", label: "Bad" },
  ];

  for (const [index, raw] of fixtures.entries()) {
    const result = hydratePanelReference(raw, {
      availablePanelIds: allModulePanels,
      fallbackInstanceId: `malformed-${index}`,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.source, "malformed");
    assert.equal(result.recovery?.reason, "malformed");
    assert.equal(result.recovery?.canRetry, false);
    assert.equal(result.recovery?.canRemove, true);
    assert.equal(result.raw, raw);
  }
});
