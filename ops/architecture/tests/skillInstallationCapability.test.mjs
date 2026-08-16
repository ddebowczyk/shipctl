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
let skillInstallationClientFor;
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
  ({ skillInstallationClientFor } = await vite.ssrLoadModule(
    "/modules/skills/frontend/src/skillInstallationClient.ts",
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

const rawSkillArbitrary = fc.record({
  name: skillNameArbitrary,
  title: fc.string(),
  description: fc.string(),
  installed: fc.boolean(),
});

const rawCatalogArbitrary = fc.uniqueArray(rawSkillArbitrary, {
  selector: ({ name }) => name,
});
const projectIdArbitrary = fc
  .string({ minLength: 1 })
  .filter((value) => value.trim().length > 0);

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
    rawCatalogArbitrary,
    async (projectId, rawCatalog) => {
      const requests = [];
      const transport = {
        inspectSkills: async (request) => {
          requests.push(request);
          return rawCatalog;
        },
        installSkill: async () => undefined,
        removeSkill: async () => undefined,
      };
      const { activation, identity, service } = productionService(transport);
      const outcome = await service.inspectSkills.execute({ projectId });
      assert.deepEqual(outcome.result, {
        ok: true,
        value: rawCatalog.map((raw) => ({
          skillId: raw.name,
          title: raw.title,
          description: raw.description,
          installed: raw.installed,
        })),
      });
      assert.deepEqual(requests, [{
        activation: identity,
        correlationId: outcome.correlationId,
        input: { projectId },
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
      const { activation, service } = productionService({
        inspectSkills: async () => { throw new Error(message); },
        installSkill: async () => undefined,
        removeSkill: async () => undefined,
      });
      const outcome = await service.inspectSkills.execute({ projectId: "/repo" });
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
      const transport = {
        inspectSkills: async () => [],
        installSkill: async (request) => { calls.push(["install", request]); },
        removeSkill: async (request) => { calls.push(["remove", request]); },
      };
      const { activation, identity, service } = productionService(transport);

      const invalidProject = await service.installSkill.execute({
        projectId: " ",
        skillId: name,
      });
      assert.equal(invalidProject.result.ok, false);
      assert.equal(invalidProject.result.error.code, "skill-installation.invalid-project");
      assert.equal(calls.length, 0);

      const invalidSkill = await service.installSkill.execute({
        projectId,
        skillId: "../outside",
      });
      assert.equal(invalidSkill.result.ok, false);
      assert.equal(invalidSkill.result.error.code, "skill-installation.invalid-request");
      assert.equal(calls.length, 0);

      const installed = await service.installSkill.execute(
        { projectId, skillId: name },
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

        const removed = await service.removeSkill.execute({ projectId, skillId: name });
        assert.deepEqual(removed.result, {
          ok: true,
          value: { projectId, skillId: name, installed: false },
        });
        assert.equal(calls.length, 2);
      }

      await activation.dispose();
      const disposed = await service.inspectSkills.execute({ projectId });
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
      const host = new SemanticServiceTestHost([
        createFakeSkillInstallationServiceProvider({
          trace,
          projects: [{
            projectId,
            skills: [{
              skillId: skillId(name),
              title,
              description,
              installed: false,
            }],
          }],
        }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.skills"));
      const client = skillInstallationClientFor(activation.context);

      assert.deepEqual(await client.listSkills(projectId), [{
        name,
        title,
        description,
        installed: false,
      }]);
      await client.installSkill(projectId, name);
      assert.equal((await client.listSkills(projectId))[0].installed, true);
      await client.removeSkill(projectId, name);
      assert.equal((await client.listSkills(projectId))[0].installed, false);
      await assert.rejects(client.installSkill(projectId, "../invalid"), /Invalid skill/);
      assert.deepEqual(trace.map(({ operation }) => operation), [
        "inspect-skills",
        "install-skill",
        "inspect-skills",
        "remove-skill",
        "inspect-skills",
      ]);
      assert.ok(trace.every(({ request }) => (
        request.activation.activationId === activation.context.identity.activationId
      )));

      await activation.dispose();
      await assert.rejects(client.listSkills(projectId), /no longer active/);
    },
  ), propertyParameters());
});
