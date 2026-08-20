import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
} from "@shipctl/module-api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

type RegistryModule = typeof import("../globalSurfaceRegistry.ts");
type HostModule = typeof import("../GlobalSurfaceHost.tsx");
type AcceptedRuntimeModule = typeof import("../AcceptedWorkspaceContributionRuntime.tsx");
type WorkspaceContributionCatalogModule = typeof import("../workspaceContributionCatalog.ts");
type UIStoreModule = typeof import("../../shared/useUIStore.ts");
type RepoStoreModule = typeof import("../../projects/useRepoStore.ts");

let vite: ViteDevServer;
let GlobalSurfaceRegistry: RegistryModule["GlobalSurfaceRegistry"];
let GlobalSurfaceRegistrationError: RegistryModule["GlobalSurfaceRegistrationError"];
let GlobalSurfaceHost: HostModule["default"];
let AcceptedWorkspaceContributionRuntimeProvider: AcceptedRuntimeModule["AcceptedWorkspaceContributionRuntimeProvider"];
let WorkspaceContributionCatalog: WorkspaceContributionCatalogModule["WorkspaceContributionCatalog"];
let useUIStore: UIStoreModule["useUIStore"];
let useRepoStore: RepoStoreModule["useRepoStore"];

const surface: GlobalSurfaceContribution = {
  id: "fixture.surface",
  moduleId: "fixture",
  load: async () => ({ default: () => null }),
};
const navigation: GlobalNavigationContribution = {
  id: "fixture.navigation",
  moduleId: "fixture",
  surfaceId: "fixture.surface",
  label: "Fixture",
  icon: { name: "circle" },
};

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ GlobalSurfaceRegistry, GlobalSurfaceRegistrationError } = await vite.ssrLoadModule(
    "/core/frontend/host/globalSurfaceRegistry.ts",
  ) as RegistryModule);
  ({ default: GlobalSurfaceHost } = await vite.ssrLoadModule(
    "/core/frontend/host/GlobalSurfaceHost.tsx",
  ) as HostModule);
  ({ AcceptedWorkspaceContributionRuntimeProvider } = await vite.ssrLoadModule(
    "/core/frontend/host/AcceptedWorkspaceContributionRuntime.tsx",
  ) as AcceptedRuntimeModule);
  ({ WorkspaceContributionCatalog } = await vite.ssrLoadModule(
    "/core/frontend/host/workspaceContributionCatalog.ts",
  ) as WorkspaceContributionCatalogModule);
  ({ useUIStore } = await vite.ssrLoadModule(
    "/core/frontend/shared/useUIStore.ts",
  ) as UIStoreModule);
  ({ useRepoStore } = await vite.ssrLoadModule(
    "/core/frontend/projects/useRepoStore.ts",
  ) as RepoStoreModule);
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  useUIStore.setState({ activeGlobalSurfaceId: null });
  useRepoStore.setState({ activeRepoPath: null, activeConfig: null });
});

test("registry composes a namespaced surface and navigation action", () => {
  const registry = GlobalSurfaceRegistry.create({
    surfaces: [surface],
    navigation: [navigation],
  });
  assert.equal(registry.surface("fixture.surface"), surface);
  assert.deepEqual(registry.navigation(), [navigation]);
});

test("registry rejects malformed, duplicate, dangling, and cross-module declarations", () => {
  assert.throws(
    () => GlobalSurfaceRegistry.create({ surfaces: [{ ...surface, id: "invalid" as "x.y" }] }),
    (error) => error instanceof GlobalSurfaceRegistrationError
      && error.code === "invalid-surface-id",
  );
  assert.throws(
    () => GlobalSurfaceRegistry.create({ surfaces: [surface, surface] }),
    (error) => error instanceof GlobalSurfaceRegistrationError
      && error.code === "duplicate-surface-id",
  );
  assert.throws(
    () => GlobalSurfaceRegistry.create({
      surfaces: [surface],
      navigation: [{ ...navigation, id: "invalid" as "x.y" }],
    }),
    (error) => error instanceof GlobalSurfaceRegistrationError
      && error.code === "invalid-navigation-id",
  );
  assert.throws(
    () => GlobalSurfaceRegistry.create({
      surfaces: [surface],
      navigation: [navigation, navigation],
    }),
    (error) => error instanceof GlobalSurfaceRegistrationError
      && error.code === "duplicate-navigation-id",
  );
  assert.throws(
    () => GlobalSurfaceRegistry.create({ navigation: [navigation] }),
    (error) => error instanceof GlobalSurfaceRegistrationError
      && error.code === "missing-surface",
  );
  assert.throws(
    () => GlobalSurfaceRegistry.create({
      surfaces: [surface],
      navigation: [{ ...navigation, moduleId: "other" }],
    }),
    (error) => error instanceof GlobalSurfaceRegistrationError
      && error.code === "module-mismatch",
  );
});

test("global surface activation is mutually exclusive and toggles closed", () => {
  useUIStore.getState().toggleGlobalSurface("fixture.surface");
  assert.equal(useUIStore.getState().activeGlobalSurfaceId, "fixture.surface");

  useUIStore.getState().toggleGlobalSurface("other.surface");
  assert.equal(useUIStore.getState().activeGlobalSurfaceId, "other.surface");

  useUIStore.getState().toggleGlobalSurface("other.surface");
  assert.equal(useUIStore.getState().activeGlobalSurfaceId, null);
});

test("global surface activation survives project switches", () => {
  useRepoStore.setState({ activeRepoPath: "/work/alpha" });
  useUIStore.getState().toggleGlobalSurface("fixture.surface");
  useRepoStore.setState({ activeRepoPath: "/work/beta" });

  assert.equal(useRepoStore.getState().activeRepoPath, "/work/beta");
  assert.equal(useUIStore.getState().activeGlobalSurfaceId, "fixture.surface");
});

test("an unknown or disabled surface renders a recoverable host state", () => {
  const catalog = WorkspaceContributionCatalog.create({
    registryRevision: 1,
    modules: [],
    activationContextsByModule: new Map(),
  });
  const markup = renderToStaticMarkup(createElement(
    AcceptedWorkspaceContributionRuntimeProvider,
    { catalog, moduleActivations: new Map() },
    createElement(GlobalSurfaceHost, {
      surfaceId: "fixture.disabled",
      close: () => undefined,
    }),
  ));
  assert.match(markup, /Surface unavailable/);
  assert.match(markup, /fixture.disabled is not registered in this build/);
  assert.match(markup, />Close</);
});
