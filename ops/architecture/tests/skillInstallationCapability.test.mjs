import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createFakeSkillInstallationServiceProvider;
let createSkillInstallationServiceProvider;
let createTestActivationIdentity;
let SemanticServiceRegistry;
let SemanticServiceTestHost;
let skillId;
let skillInstallationService;

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
  ({ skillId, skillInstallationService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeSkillInstallationServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createSkillInstallationServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/skillInstallation.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const skillNameArbitrary = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
    fc.stringMatching(/^[a-z0-9-]{0,18}$/),
  )
  .map(([head, tail]) => `${head}${tail}`);

const catalogEntryArbitrary = fc.record({
  skillId: skillNameArbitrary,
  title: fc.string(),
  description: fc.string(),
  installed: fc.boolean(),
});

const catalogArbitrary = fc.uniqueArray(catalogEntryArbitrary, {
  selector: ({ skillId: id }) => id,
});
const projectIdArbitrary = fc
  .string({ minLength: 1 })
  .filter((value) => value.trim().length > 0);

function fullTransport(overrides = {}) {
  return {
    inspectInstallations: async () => [],
    installSource: async () => undefined,
    removeInstallation: async () => undefined,
    releaseActivation: async () => undefined,
    ...overrides,
  };
}

function productionService(transport) {
  const registry = new SemanticServiceRegistry([
    createSkillInstallationServiceProvider({ transport }),
  ]);
  const identity = createTestActivationIdentity("shipctl.skills");
  const activation = registry.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(skillInstallationService),
  };
}

test("architecture.service-adapter.skill-installation.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    catalogArbitrary,
    async (projectId, catalog) => {
      const requests = [];
      const transport = fullTransport({
        inspectInstallations: async (request) => {
          requests.push(request);
          return catalog.map(({ skillId: id, installed }) => ({ skillId: id, installed }));
        },
      });
      const { activation, identity, service } = productionService(transport);
      const descriptors = catalog.map(({ installed: _installed, ...descriptor }) => descriptor);
      const outcome = await service.inspectSkills.execute({ projectId, catalog: descriptors });
      assert.deepEqual(outcome.result, {
        ok: true,
        value: catalog.map((entry) => ({ ...entry })),
      });
      assert.deepEqual(requests, [{
        activation: identity,
        correlationId: outcome.correlationId,
        input: { projectId, skillIds: catalog.map(({ skillId: id }) => id) },
      }]);
      await activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.string({ minLength: 1 }),
    fc.constantFrom(
      "permission denied",
      "Project is not registered: fixture",
      "Unknown skill: fixture",
      "filesystem failed",
    ),
    async (detail, prefix) => {
      const message = `${prefix}: ${detail}`;
      const { activation, service } = productionService(fullTransport({
        inspectInstallations: async () => { throw new Error(message); },
      }));
      const outcome = await service.inspectSkills.execute({ projectId: "/repo", catalog: [] });
      const expected = prefix.startsWith("permission")
        ? "skill-installation.denied"
        : prefix.startsWith("Project")
          ? "skill-installation.invalid-project"
          : prefix.startsWith("Unknown")
            ? "skill-installation.unknown-skill"
            : "skill-installation.transport-failed";
      assert.equal(outcome.result.ok, false);
      assert.equal(outcome.result.error.code, expected);
      assert.equal(outcome.result.error.message, message);
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-request.skill-installation.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    skillNameArbitrary,
    fc.boolean(),
    async (projectId, name, cancelled) => {
      const calls = [];
      const transport = fullTransport({
        installSource: async (request) => { calls.push(["install", request]); },
        removeInstallation: async (request) => { calls.push(["remove", request]); },
      });
      const { activation, identity, service } = productionService(transport);
      const skill = {
        skillId: name,
        title: "Generated skill",
        description: "Generated source",
        markdown: `---\nname: ${name}\n---\n\n# Generated\n`,
      };

      const invalidProject = await service.installSkill.execute({
        projectId: " ",
        skill,
      });
      assert.equal(invalidProject.result.ok, false);
      assert.equal(invalidProject.result.error.code, "skill-installation.invalid-project");
      assert.equal(calls.length, 0);

      const invalidSkill = await service.installSkill.execute({
        projectId,
        skill: { ...skill, skillId: "../outside" },
      });
      assert.equal(invalidSkill.result.ok, false);
      assert.equal(invalidSkill.result.error.code, "skill-installation.invalid-request");
      assert.equal(calls.length, 0);

      const installed = await service.installSkill.execute(
        { projectId, skill },
        { cancellation: { cancelled } },
      );
      if (cancelled) {
        assert.equal(installed.result.ok, false);
        assert.equal(installed.result.error.code, "skill-installation.cancelled");
        assert.equal(calls.length, 0);
      } else {
        assert.deepEqual(installed.result, {
          ok: true,
          value: { projectId, skillId: name, installed: true },
        });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0][1].activation, identity);
        assert.equal(calls[0][1].correlationId, installed.correlationId);
        assert.deepEqual(calls[0][1].input, { projectId, skillId: name, markdown: skill.markdown });

        const removed = await service.removeSkill.execute({ projectId, skillId: name });
        assert.deepEqual(removed.result, {
          ok: true,
          value: { projectId, skillId: name, installed: false },
        });
        assert.equal(calls.length, 2);
      }

      await activation.dispose();
      const disposed = await service.inspectSkills.execute({ projectId, catalog: [] });
      assert.equal(disposed.result.ok, false);
      assert.equal(disposed.result.error.code, "skill-installation.activation-disposed");
    },
  ), propertyParameters());
});

test("architecture.skill-installation-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    skillNameArbitrary,
    fc.string(),
    fc.string(),
    async (projectId, name, title, description) => {
      const trace = [];
      const descriptor = { skillId: skillId(name), title, description };
      const host = new SemanticServiceTestHost([
        createFakeSkillInstallationServiceProvider({
          trace,
          projects: [{
            projectId,
            skills: [{ ...descriptor, installed: false }],
          }],
        }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.skills"));
      const service = activation.context.services.require(skillInstallationService);

      const inspected = await service.inspectSkills.execute({ projectId, catalog: [descriptor] });
      assert.deepEqual(inspected.result, {
        ok: true,
        value: [{ ...descriptor, installed: false }],
      });
      const installed = await service.installSkill.execute({
        projectId,
        skill: {
          ...descriptor,
          markdown: `---\nname: ${name}\n---\n\n# Generated\n`,
        },
      });
      assert.equal(installed.result.value.installed, true);
      const removed = await service.removeSkill.execute({ projectId, skillId: skillId(name) });
      assert.equal(removed.result.value.installed, false);
      assert.deepEqual(trace.map(({ operation }) => operation), [
        "inspect-skills",
        "install-skill",
        "remove-skill",
      ]);
      assert.ok(trace.every(({ request }) => (
        request.activation.activationId === activation.context.identity.activationId
      )));

      await activation.dispose();
      const disposed = await service.inspectSkills.execute({ projectId, catalog: [descriptor] });
      assert.equal(disposed.result.error.code, "skill-installation.activation-disposed");
    },
  ), propertyParameters());
});
