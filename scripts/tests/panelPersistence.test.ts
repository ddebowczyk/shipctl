import assert from "node:assert/strict";
import test from "node:test";

import {
  hydratePanelReference,
  LEGACY_PANEL_IDS,
  PANEL_REFERENCE_SCHEMA_VERSION,
  toPersistedPanelReference,
} from "../../src/core/modules/panelPersistence.ts";

const allBuiltinPanels = Object.values(LEGACY_PANEL_IDS);

test("legacy panel tabs migrate to equivalent stable references", () => {
  for (const [kind, panelId] of Object.entries(LEGACY_PANEL_IDS)) {
    const raw = { id: `panel-${kind}`, kind, label: `Custom ${kind}` };
    const result = hydratePanelReference(raw, { availablePanelIds: allBuiltinPanels });

    assert.equal(result.status, "available");
    assert.equal(result.source, "legacy");
    assert.equal(result.instanceId, raw.id);
    assert.equal(result.panelId, panelId);
    assert.equal(result.label, raw.label);
    assert.equal(result.legacyKind, kind);
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
    legacyKind: "git",
    state,
  });
  const result = hydratePanelReference(raw, { availablePanelIds: allBuiltinPanels });

  assert.equal(raw.schemaVersion, PANEL_REFERENCE_SCHEMA_VERSION);
  assert.equal(result.status, "available");
  assert.equal(result.source, "current");
  assert.equal(result.state, state);
});

test("unknown panel IDs remain retryable and removable", () => {
  const raw = {
    schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
    instanceId: "timeline-1",
    panelId: "example.timeline",
    label: "Timeline",
    state: { cursor: 7 },
  };
  const result = hydratePanelReference(raw, { availablePanelIds: allBuiltinPanels });

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
    instanceId: "panel-todos",
    panelId: "core.todos",
    label: "To-dos",
    legacyKind: "todos",
  };
  const result = hydratePanelReference(raw, {
    availablePanelIds: ["core.git"],
    knownPanelIds: allBuiltinPanels,
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
      availablePanelIds: allBuiltinPanels,
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
