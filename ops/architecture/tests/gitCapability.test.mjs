import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createFakeGitServiceProvider;
let createGitServiceProvider;
let createTestActivationIdentity;
let FakeGitChangeController;
let gitClientFor;
let gitService;
let SemanticServiceRegistry;
let SemanticServiceTestHost;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) {
    throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  }
  return { seed };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ gitService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeGitServiceProvider,
    createTestActivationIdentity,
    FakeGitChangeController,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createGitServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/git.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ));
  ({ gitClientFor } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/gitClient.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const projectIdArbitrary = fc.string({ minLength: 1 })
  .filter((value) => value.trim().length > 0);
const pathSegmentArbitrary = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/u);
const relativePathArbitrary = fc.array(pathSegmentArbitrary, { minLength: 1 })
  .map((segments) => segments.join("/"));
const countArbitrary = fc.integer({ min: 0, max: 4_294_967_295 });
const rawStatusArbitrary = fc.record({
  is_git_repo: fc.boolean(),
  branch: fc.string(),
  dirty: fc.boolean(),
  staged: countArbitrary,
  unstaged: countArbitrary,
  untracked: countArbitrary,
  ahead: countArbitrary,
  behind: countArbitrary,
  worktree_parent: fc.option(projectIdArbitrary, { nil: null }),
});
const rawWorktreeArbitrary = fc.record({
  path: projectIdArbitrary,
  branch: fc.option(fc.string(), { nil: null }),
  is_main: fc.boolean(),
});
const rawChangedFileArbitrary = fc.record({
  path: relativePathArbitrary,
  status: fc.string(),
  area: fc.constantFrom("staged", "unstaged", "untracked"),
  old_path: fc.option(relativePathArbitrary, { nil: null }),
});
const rawDiffStatArbitrary = fc.record({
  path: relativePathArbitrary,
  additions: countArbitrary,
  deletions: countArbitrary,
});

function transportWith(overrides = {}) {
  return {
    isRepository: async () => true,
    initializeRepository: async () => undefined,
    currentBranch: async () => "main",
    listBranches: async () => ["main"],
    pushBranch: async () => undefined,
    listWorktrees: async () => [],
    createWorktree: async ({ input }) => ({
      path: `${input.projectId}#${input.branchName}`,
      branch: input.branchName,
    }),
    inspectStatus: async () => ({
      is_git_repo: true,
      branch: "main",
      dirty: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
      worktree_parent: null,
    }),
    listChangedFiles: async () => [],
    readFileDiff: async () => "",
    readFile: async () => "",
    listFiles: async () => [],
    stageFile: async () => undefined,
    stageAll: async () => undefined,
    commit: async () => undefined,
    unstageFile: async () => undefined,
    unstageAll: async () => undefined,
    switchBranch: async () => undefined,
    createBranch: async () => undefined,
    diffStats: async () => [],
    releaseActivation: async () => true,
    subscribeChanges: async () => () => undefined,
    ...overrides,
  };
}

function productionService(transport, moduleId = "shipctl.git") {
  const registry = new SemanticServiceRegistry([
    createGitServiceProvider({ transport }),
  ]);
  const identity = createTestActivationIdentity(moduleId);
  const activation = registry.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(gitService),
  };
}

function expectedStatus(raw) {
  return {
    isRepository: raw.is_git_repo,
    branchName: raw.branch,
    dirty: raw.dirty,
    stagedCount: raw.staged,
    unstagedCount: raw.unstaged,
    untrackedCount: raw.untracked,
    aheadCount: raw.ahead,
    behindCount: raw.behind,
    worktreeParentProjectId: raw.worktree_parent,
  };
}

test("architecture.service-adapter.git.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    rawStatusArbitrary,
    fc.array(rawWorktreeArbitrary),
    fc.array(rawChangedFileArbitrary),
    fc.array(rawDiffStatArbitrary),
    async (projectId, rawStatus, rawWorktrees, rawFiles, rawStats) => {
      const requests = [];
      const capture = (value) => async (request) => {
        requests.push(request);
        return value;
      };
      const { activation, identity, service } = productionService(transportWith({
        inspectStatus: capture(rawStatus),
        listWorktrees: capture(rawWorktrees),
        listChangedFiles: capture(rawFiles),
        diffStats: capture(rawStats),
      }));

      const outcomes = await Promise.all([
        service.inspectStatus.execute({ projectId }),
        service.listWorktrees.execute({ projectId }),
        service.listChangedFiles.execute({ projectId }),
        service.diffStats.execute({ projectId }),
      ]);
      assert.deepEqual(outcomes.map(({ result }) => result), [
        { ok: true, value: expectedStatus(rawStatus) },
        {
          ok: true,
          value: rawWorktrees.map((value) => ({
            projectId: value.path,
            branchName: value.branch,
            isMain: value.is_main,
          })),
        },
        {
          ok: true,
          value: rawFiles.map((value) => ({
            relativePath: value.path,
            status: value.status,
            area: value.area,
            previousRelativePath: value.old_path,
          })),
        },
        {
          ok: true,
          value: rawStats.map((value) => ({
            relativePath: value.path,
            additions: value.additions,
            deletions: value.deletions,
          })),
        },
      ]);
      assert.equal(requests.length, outcomes.length);
      requests.forEach((request, index) => {
        assert.deepEqual(request.activation, identity);
        assert.equal(request.correlationId, outcomes[index].correlationId);
        assert.deepEqual(request.input, { projectId });
      });
      await activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(
      ["Project is not registered", "git.invalid-project"],
      ["not a git repository", "git.not-repository"],
      ["file path is outside project", "git.invalid-path"],
      ["permission denied", "git.denied"],
      ["index.lock conflict", "git.conflict"],
      ["unexpected process failure", "git.transport-failed"],
    ),
    async ([message, code]) => {
      const { activation, service } = productionService(transportWith({
        inspectStatus: async () => { throw new Error(message); },
      }));
      const outcome = await service.inspectStatus.execute({ projectId: "/project" });
      assert.deepEqual(outcome.result, {
        ok: false,
        error: { code, message, retryable: false },
      });
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-request.git.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    relativePathArbitrary,
    fc.string({ minLength: 1 }).filter((value) => (
      value.trim().length > 0 && value !== "main"
    )),
    async (projectId, relativePath, branchName) => {
      const dispatches = [];
      const dispatch = async (request) => { dispatches.push(request); };
      const { activation, identity, service } = productionService(transportWith({
        stageFile: dispatch,
        createBranch: dispatch,
        commit: dispatch,
      }));

      for (const invalidPath of ["", "/absolute", "../escape", "a/../escape", "a//b"]) {
        const invalid = await service.stageFile.execute({
          projectId,
          relativePath: invalidPath,
        });
        assert.equal(invalid.result.ok, false);
        assert.equal(invalid.result.error.code, "git.invalid-path");
      }
      const invalidBranch = await service.createBranch.execute({ projectId, branchName: " " });
      assert.equal(invalidBranch.result.ok, false);
      assert.equal(invalidBranch.result.error.code, "git.invalid-request");
      const invalidCommit = await service.commit.execute({ projectId, message: " " });
      assert.equal(invalidCommit.result.ok, false);
      assert.equal(invalidCommit.result.error.code, "git.invalid-request");
      assert.equal(dispatches.length, 0);

      const cancelled = await service.stageFile.execute(
        { projectId, relativePath },
        { cancellation: { cancelled: true } },
      );
      assert.equal(cancelled.result.ok, false);
      assert.equal(cancelled.result.error.code, "git.cancelled");
      assert.equal(dispatches.length, 0);

      const staged = await service.stageFile.execute({ projectId, relativePath });
      const branched = await service.createBranch.execute({ projectId, branchName });
      assert.deepEqual(staged.result, { ok: true, value: { projectId } });
      assert.deepEqual(branched.result, { ok: true, value: { projectId } });
      assert.equal(dispatches.length, 2);
      assert.deepEqual(dispatches.map(({ activation: seen }) => seen), [identity, identity]);
      assert.deepEqual(
        dispatches.map(({ correlationId }) => correlationId),
        [staged.correlationId, branched.correlationId],
      );

      await activation.dispose();
      const disposed = await service.stageFile.execute({ projectId, relativePath });
      assert.equal(disposed.result.ok, false);
      assert.equal(disposed.result.error.code, "git.activation-disposed");
      assert.equal(dispatches.length, 2);
    },
  ), propertyParameters());
});

test("architecture.service-event.git.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    projectIdArbitrary,
    fc.array(fc.boolean()),
    fc.boolean(),
    async (projectId, otherProjectId, matchingEvents, disposeActivation) => {
      fc.pre(projectId !== otherProjectId);
      let transportListener;
      let unsubscribeCount = 0;
      let subscribedIdentity;
      const { activation, identity, service } = productionService(transportWith({
        subscribeChanges: async (seenIdentity, listener) => {
          subscribedIdentity = seenIdentity;
          transportListener = listener;
          return () => { unsubscribeCount += 1; };
        },
      }));
      const received = [];
      const lease = await service.repositoryChanges.subscribe(
        { projectId },
        (event) => { received.push(event); },
      );
      assert.deepEqual(subscribedIdentity, identity);

      for (const matching of matchingEvents) {
        transportListener({ paths: [matching ? projectId : otherProjectId] });
      }
      await new Promise((resolve) => setImmediate(resolve));
      const matchCount = matchingEvents.filter(Boolean).length;
      assert.deepEqual(received, Array.from({ length: matchCount }, (_, index) => ({
        sourceId: "shipctl.git.repository-changes",
        sequence: index + 1,
        value: { projectId },
      })));

      if (disposeActivation) await activation.dispose();
      else await lease.dispose();
      assert.equal(unsubscribeCount, 1);
      transportListener({ paths: [projectId] });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(received.length, matchCount);
      if (!disposeActivation) await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.git-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    relativePathArbitrary,
    fc.string(),
    fc.string({ minLength: 1 }).filter((value) => (
      value.trim().length > 0 && value !== "main"
    )),
    async (projectId, relativePath, contents, branchName) => {
      const trace = [];
      const changes = new FakeGitChangeController();
      const host = new SemanticServiceTestHost([
        createFakeGitServiceProvider({
          changes,
          trace,
          repositories: [{
            projectId,
            files: [{ relativePath, working: contents }],
            changedFiles: [{
              relativePath,
              status: "M",
              area: "unstaged",
              previousRelativePath: null,
            }],
          }],
        }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.git"));
      const client = gitClientFor(activation.context);
      let changeCount = 0;
      await client.subscribeChanges(projectId, () => { changeCount += 1; });

      assert.deepEqual(await client.listFiles(projectId), [relativePath]);
      assert.equal(await client.fileContents(projectId, relativePath, "working"), contents);
      assert.equal((await client.changedFiles(projectId))[0].relativePath, relativePath);
      const created = await client.createWorktree(projectId, branchName);
      assert.equal(created.branchName, branchName);
      assert.equal(changeCount, 1);
      assert.deepEqual(
        trace.map(({ operation }) => operation),
        ["list-files", "read-file", "list-changed-files", "create-worktree"],
      );
      assert.ok(trace.every(({ request }) => (
        request.activation.activationId === activation.context.identity.activationId
      )));

      await activation.dispose();
      await changes.publish(projectId);
      assert.equal(changeCount, 1);
    },
  ), propertyParameters());
});
