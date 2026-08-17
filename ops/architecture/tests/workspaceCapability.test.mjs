import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let InMemoryWorkspacePersistence;
let WorkspaceAuthority;
let WorkspaceCatalogParseError;
let createWorkspaceServiceProvider;
let parseWorkspaceCommand;
let parseUiWorkspaceDocument;
let parseWorkspaceCatalogSnapshot;
let SemanticServiceTestHost;
let createTestActivationIdentity;
let workspaceService;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  return { seed };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({
    InMemoryWorkspacePersistence,
    WorkspaceAuthority,
    WorkspaceCatalogParseError,
    createWorkspaceServiceProvider,
    parseWorkspaceCommand,
    parseUiWorkspaceDocument,
    parseWorkspaceCatalogSnapshot,
  } = await vite.ssrLoadModule("/core/frontend/workspace/index.ts"));
  ({ workspaceService } = await vite.ssrLoadModule("/module-api/frontend/src/index.ts"));
  ({
    SemanticServiceTestHost,
    createTestActivationIdentity,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
});

after(async () => {
  await vite?.close();
});

function viewDefinition({
  viewTypeId,
  scope,
  cardinality,
  closeBehavior = "hide",
  revision,
}) {
  const ownerModuleId = viewTypeId.split(".").slice(0, 2).join(".");
  return {
    viewTypeId,
    ownerModuleId,
    ownerActivationId: `${ownerModuleId}@1#${revision}`,
    label: viewTypeId,
    scope,
    cardinality,
    closeBehavior,
    requiredCapabilityIds: [],
    placement: { defaultRegion: "primary", allowSplit: true },
    state: { kind: "json", schemaVersion: 1 },
    presentation: { loaderId: `${viewTypeId}.view`, exportName: "default" },
    migrationAliases: [],
  };
}

function catalog(revision, { usage = true, usageOwnerRevision = 1 } = {}) {
  return {
    schemaVersion: 1,
    revision,
    definitions: [
      viewDefinition({
        viewTypeId: "shipctl.terminal",
        scope: "terminal",
        cardinality: "one-per-resource",
        revision: 1,
      }),
      ...(usage ? [viewDefinition({
        viewTypeId: "shipctl.usage",
        scope: "global",
        cardinality: "singleton",
        revision: usageOwnerRevision,
      })] : []),
    ],
  };
}

function emptyProfile({ workspaceId }) {
  return {
    schemaVersion: 1,
    workspaceId,
    profileId: "shipctl.test.empty",
    instances: [],
    root: null,
    floating: [],
    maximizedStackId: null,
  };
}

async function authorityFixture({ usage = true } = {}) {
  const persistence = new InMemoryWorkspacePersistence();
  const currentCatalog = catalog(1, { usage });
  const authority = await WorkspaceAuthority.open({
    workspaceId: "shipctl.test.workspace",
    catalog: currentCatalog,
    persistence,
    defaultProfile: emptyProfile,
  });
  return {
    authority,
    persistence,
    catalogRevision: 1,
    currentCatalog,
    usage,
    usageOwnerRevision: 1,
  };
}

function terminalResource(number) {
  return { kind: "terminal", terminalId: `terminal-${number}`, projectId: "project-a" };
}

function documentStacks(document) {
  const stacks = [];
  const visit = (node) => {
    if (node.kind === "stack") {
      stacks.push(node);
      return;
    }
    visit(node.first);
    visit(node.second);
  };
  if (document.root) visit(document.root);
  for (const item of document.floating) stacks.push(item.stack);
  return stacks;
}

/** An independent tree walk: it does not use the workspace parser or reducer. */
function assertSemanticDocument(document, activeDefinitions) {
  const instances = new Map(document.instances.map((item) => [item.instanceId, item]));
  const placed = new Set();
  const stacks = documentStacks(document);
  const nodeIds = new Set();

  const visit = (node) => {
    const id = node.kind === "stack" ? node.stackId : node.nodeId;
    assert.equal(nodeIds.has(id), false, `duplicate node ${id}`);
    nodeIds.add(id);
    if (node.kind === "stack") {
      assert.ok(node.instanceIds.length > 0, "stack is non-empty");
      assert.ok(node.instanceIds.includes(node.selectedInstanceId), "selection belongs to stack");
      for (const instanceId of node.instanceIds) {
        assert.ok(instances.has(instanceId), `placed instance ${instanceId} exists`);
        assert.equal(placed.has(instanceId), false, `instance ${instanceId} has one placement`);
        placed.add(instanceId);
      }
      return;
    }
    assert.ok(node.firstShare > 0 && node.firstShare < 1, "split share stays semantic");
    visit(node.first);
    visit(node.second);
  };
  if (document.root) visit(document.root);
  for (const floating of document.floating) visit(floating.stack);

  for (const instance of document.instances) {
    assert.equal(instance.lifecycle === "placed", placed.has(instance.instanceId));
    const definition = activeDefinitions.get(instance.viewTypeId);
    if (definition) {
      assert.equal(instance.availability.kind, "available");
      assert.equal(instance.ownerModuleId, definition.ownerModuleId);
      assert.equal(instance.ownerActivationId, definition.ownerActivationId);
    } else {
      assert.equal(instance.availability.kind, "missing-definition");
      assert.equal(instance.availability.lastKnownViewTypeId, instance.viewTypeId);
    }
  }

  for (const stack of stacks) {
    for (const instanceId of stack.instanceIds) assert.ok(instances.has(instanceId));
  }
}

async function applyHistoryStep(fixture, step, index) {
  const inspection = fixture.authority.inspect(true);
  const document = inspection.document;
  const revision = inspection.revision;
  const originId = `property-${index}-${step}`;
  const existing = (id) => document.instances.find((item) => item.instanceId === id);
  const stackFor = (id) => documentStacks(document).find((stack) => stack.instanceIds.includes(id));

  if (step === "open-terminal-1" || step === "open-terminal-2") {
    const number = step.endsWith("1") ? 1 : 2;
    await fixture.authority.mutate({
      kind: "open",
      expectedRevision: revision,
      originId,
      instanceId: `terminal-instance-${number}`,
      viewTypeId: "shipctl.terminal",
      resource: terminalResource(number),
      placement: { kind: "default" },
      label: null,
      stateRef: { number },
    });
    return;
  }
  if (step === "open-usage") {
    if (!fixture.usage) return;
    await fixture.authority.mutate({
      kind: "open",
      expectedRevision: revision,
      originId,
      instanceId: "usage-instance",
      viewTypeId: "shipctl.usage",
      resource: { kind: "global" },
      placement: { kind: "default" },
      label: null,
      stateRef: null,
    });
    return;
  }
  if (step === "close-terminal-1") {
    if (!existing("terminal-instance-1")) return;
    await fixture.authority.mutate({ kind: "close", expectedRevision: revision, originId, instanceId: "terminal-instance-1" });
    return;
  }
  if (step === "focus-terminal-1") {
    if (!existing("terminal-instance-1")) return;
    await fixture.authority.mutate({
      kind: "focus",
      expectedRevision: revision,
      originId,
      instanceId: "terminal-instance-1",
      placement: { kind: "default" },
    });
    return;
  }
  if (step === "disable-usage" || step === "restore-usage" || step === "replace-usage") {
    const nextUsage = step === "disable-usage" ? false : fixture.usage || step === "restore-usage";
    if (step === "replace-usage" && !fixture.usage) return;
    if (fixture.usage === nextUsage && step !== "replace-usage") return;
    fixture.catalogRevision += 1;
    if (step === "replace-usage") fixture.usageOwnerRevision += 1;
    fixture.usage = nextUsage;
    fixture.currentCatalog = catalog(fixture.catalogRevision, {
      usage: nextUsage,
      usageOwnerRevision: fixture.usageOwnerRevision,
    });
    await fixture.authority.reconcileCatalog({
      catalog: fixture.currentCatalog,
      expectedRevision: revision,
      originId,
    });
    return;
  }
  if (step === "split-terminal-2") {
    const terminalOneStack = stackFor("terminal-instance-1");
    const terminalTwoStack = stackFor("terminal-instance-2");
    if (!terminalOneStack || !terminalTwoStack) return;
    if (terminalOneStack.stackId === terminalTwoStack.stackId && terminalOneStack.instanceIds.length < 2) return;
    await fixture.authority.mutate({
      kind: "split",
      expectedRevision: revision,
      originId,
      instanceId: "terminal-instance-2",
      targetStackId: terminalOneStack.stackId,
      splitId: `split-${index}`,
      newStackId: `stack-${index}`,
      axis: "horizontal",
      position: "after",
    });
    return;
  }
  if (step === "move-terminal-2") {
    const terminalTwoStack = stackFor("terminal-instance-2");
    const target = documentStacks(document).find((stack) => stack.stackId !== terminalTwoStack?.stackId);
    if (!terminalTwoStack || !target) return;
    await fixture.authority.mutate({
      kind: "move",
      expectedRevision: revision,
      originId,
      instanceId: "terminal-instance-2",
      targetStackId: target.stackId,
      position: "end",
      relativeInstanceId: null,
    });
  }
}

test("architecture.workspace-reconcile.property", async () => {
  const action = fc.constantFrom(
    "open-terminal-1",
    "open-terminal-2",
    "open-usage",
    "close-terminal-1",
    "focus-terminal-1",
    "disable-usage",
    "restore-usage",
    "replace-usage",
    "split-terminal-2",
    "move-terminal-2",
  );
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(action, { maxLength: 40 }), async (initialUsage, history) => {
    const fixture = await authorityFixture({ usage: initialUsage });
    for (const [index, step] of history.entries()) {
      await applyHistoryStep(fixture, step, index);
      const inspection = fixture.authority.inspect(true);
      assertSemanticDocument(
        inspection.document,
        new Map(fixture.currentCatalog.definitions.map((item) => [item.viewTypeId, item])),
      );
    }
  }), propertyParameters());
});

function rawDocument({ count, split, floating, missing, state }) {
  const placedCount = floating ? count - 1 : count;
  const ids = Array.from({ length: count }, (_, index) => `instance-${index}`);
  const instance = (id, index, lifecycle = "placed") => ({
    instanceId: id,
    viewTypeId: "shipctl.test-view",
    ownerModuleId: "shipctl.test",
    ownerActivationId: "shipctl.test@1#property",
    resource: { kind: "project", projectId: `project-${index}` },
    label: null,
    stateRef: state,
    availability: missing && index === 0
      ? { kind: "missing-definition", lastKnownViewTypeId: "shipctl.test-view", catalogRevision: 2 }
      : { kind: "available" },
    lifecycle,
  });
  const rootIds = ids.slice(0, placedCount);
  const root = split && rootIds.length >= 2
    ? {
        kind: "split",
        nodeId: "split-root",
        axis: "vertical",
        firstShare: 0.4,
        first: { kind: "stack", stackId: "stack-first", instanceIds: [rootIds[0]], selectedInstanceId: rootIds[0] },
        second: {
          kind: "stack",
          stackId: "stack-second",
          instanceIds: rootIds.slice(1),
          selectedInstanceId: rootIds[1],
        },
      }
    : { kind: "stack", stackId: "stack-root", instanceIds: rootIds, selectedInstanceId: rootIds[0] };
  const floatingEntries = floating ? [{
    floatingId: "floating-one",
    stack: { kind: "stack", stackId: "stack-floating", instanceIds: [ids.at(-1)], selectedInstanceId: ids.at(-1) },
    x: 12,
    y: 24,
    width: 640,
    height: 480,
  }] : [];
  return {
    schemaVersion: 1,
    workspaceId: "shipctl.test.workspace",
    profileId: "shipctl.test.profile",
    instances: ids.map((id, index) => instance(id, index)),
    root,
    floating: floatingEntries,
    maximizedStackId: null,
  };
}

test("architecture.workspace-roundtrip.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 2, max: 5 }),
    fc.boolean(),
    fc.boolean(),
    fc.boolean(),
    fc.jsonValue(),
    async (count, split, floating, missing, state) => {
      const source = parseUiWorkspaceDocument(rawDocument({ count, split, floating, missing, state }));
      const record = {
        storageSchemaVersion: 2,
        workspaceId: source.workspaceId,
        revision: 1,
        originId: "roundtrip-property",
        catalogRevision: 1,
        document: source,
      };
      const persistence = new InMemoryWorkspacePersistence([record]);
      const restored = await persistence.load(source.workspaceId);
      assert.ok(restored);
      assert.deepEqual(restored.document, source);
      assert.deepEqual(
        documentStacks(restored.document).map((stack) => [stack.stackId, stack.instanceIds, stack.selectedInstanceId]),
        documentStacks(source).map((stack) => [stack.stackId, stack.instanceIds, stack.selectedInstanceId]),
      );
      assert.deepEqual(
        restored.document.instances.map((item) => [item.instanceId, item.viewTypeId, item.resource, item.stateRef]),
        source.instances.map((item) => [item.instanceId, item.viewTypeId, item.resource, item.stateRef]),
      );
    },
  ), propertyParameters());
});

test("architecture.workspace-bootstrap-reconcile", async () => {
  const persistence = new InMemoryWorkspacePersistence();
  const first = await WorkspaceAuthority.open({
    workspaceId: "shipctl.test.workspace",
    catalog: catalog(1),
    persistence,
    defaultProfile: emptyProfile,
  });
  await first.mutate({
    kind: "open",
    expectedRevision: first.revision,
    originId: "bootstrap-seed",
    instanceId: "usage-instance",
    viewTypeId: "shipctl.usage",
    resource: { kind: "global" },
    placement: { kind: "default" },
    label: null,
    stateRef: null,
  });

  const restored = await WorkspaceAuthority.open({
    workspaceId: "shipctl.test.workspace",
    catalog: catalog(2, { usage: false }),
    persistence,
    defaultProfile: emptyProfile,
  });
  const inspection = restored.inspect(true);
  assert.equal(inspection.catalogRevision, 2);
  assert.equal(inspection.document.instances[0].availability.kind, "missing-definition");
  assert.equal(inspection.document.instances[0].availability.catalogRevision, 2);
  assert.equal(restored.revision, 2);
});

test("architecture.workspace-contribution-schema.property", async () => {
  const mutation = fc.constantFrom(
    "layman-node",
    "renderer-prop",
    "eager-view",
    "malformed-presentation",
    "missing-identity",
  );
  await fc.assert(fc.property(mutation, (kind) => {
    const valid = catalog(1).definitions[0];
    const accepted = parseWorkspaceCatalogSnapshot({
      schemaVersion: 1,
      revision: 1,
      definitions: [valid],
    });
    assert.equal(accepted.definitions[0].viewTypeId, valid.viewTypeId);
    const invalid = kind === "layman-node"
      ? { ...valid, laymanNode: { opaque: "renderer-specific" } }
      : kind === "renderer-prop"
        ? { ...valid, renderer: { opaque: "renderer-specific" } }
        : kind === "eager-view"
          ? { ...valid, load: { opaque: "renderer-specific" } }
          : kind === "malformed-presentation"
            ? { ...valid, presentation: { loaderId: valid.presentation.loaderId, exportName: () => null } }
            : { ...valid, viewTypeId: "invalid" };
    assert.throws(() => parseWorkspaceCatalogSnapshot({
      schemaVersion: 1,
      revision: 1,
      definitions: [invalid],
    }), (error) => error instanceof WorkspaceCatalogParseError);
  }), propertyParameters());
});

test("architecture.workspace-agent-inspection", async () => {
  const fixture = await authorityFixture();
  const host = new SemanticServiceTestHost([
    createWorkspaceServiceProvider({ authority: fixture.authority }),
  ]);
  const activation = host.activate(createTestActivationIdentity("shipctl.usage"));
  const service = activation.context.services.require(workspaceService);
  const events = [];
  const lease = await service.observeWorkspace.subscribe(
    { workspaceId: fixture.authority.workspaceId },
    (event) => { events.push(event.value); },
  );
  const before = await service.inspectWorkspace.execute({
    workspaceId: fixture.authority.workspaceId,
    includeDocument: false,
  });
  assert.equal(before.result.ok, true);
  assert.equal("document" in before.result.value, false);

  const mutation = await service.mutateWorkspace.execute({
    workspaceId: fixture.authority.workspaceId,
    command: {
      kind: "open",
      expectedRevision: before.result.value.revision,
      originId: "agent-property",
      instanceId: "terminal-agent",
      viewTypeId: "shipctl.terminal",
      resource: terminalResource("agent"),
      placement: { kind: "default" },
      label: null,
      stateRef: null,
    },
  });
  assert.equal(mutation.result.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "workspace-changed");
  assert.equal(events[0].revision, mutation.result.value.revision);

  assert.throws(
    () => parseWorkspaceCommand({
      kind: "close",
      expectedRevision: mutation.result.value.revision,
      originId: "agent-property",
      instanceId: "terminal-agent",
      profileId: "irrelevant-field",
    }),
    (error) => error?.code === "workspace.invalid-request",
  );
  await lease.dispose();
  await activation.dispose();
});
