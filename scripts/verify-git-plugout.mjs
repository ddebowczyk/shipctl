#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  readJson,
  removeCargoDefaultFeature,
  replaceOnce,
  run,
  verifyModulePlugout,
  writeJson,
} from "./lib/module-plugout.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function removeFrontendComposition(root) {
  replaceOnce(
    root,
    "src/core/modules/enabledModules.ts",
    'import { gitModule } from "@shep/module-git";\n',
    "",
  );
  replaceOnce(
    root,
    "src/core/modules/enabledModules.ts",
    '  ...(import.meta.env.VITE_SHEP_GIT_MODULE === "disabled" ? [] : [gitModule]),\n',
    "",
  );
}

function removeNativeComposition(root) {
  removeCargoDefaultFeature(root, "git-module");
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'git-module = ["dep:shep-module-git"]\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'shep-module-git = { package = "tauri-plugin-shep-git", path = "../modules/git/backend", optional = true }\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/enabled_modules.rs",
    '    #[cfg(feature = "git-module")]\n    let builder = builder.plugin(shep_module_git::init(crate::git_module::host_services()));\n\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/lib.rs",
    '#[cfg(feature = "git-module")]\nmod git_module;\n',
    "",
  );
  rmSync(path.join(root, "src-tauri/src/git_module.rs"), { force: true });
}

function removeGitCapability(root, relativePath) {
  if (!existsSync(path.join(root, relativePath))) return;
  const config = readJson(root, relativePath);
  const capabilities = config.app?.security?.capabilities;
  if (Array.isArray(capabilities)) {
    config.app.security.capabilities = capabilities.filter(
      (capability) => typeof capability !== "object" || capability?.identifier !== "git",
    );
  }
  writeJson(root, relativePath, config);
}

function removeSmokeDependency(root) {
  replaceOnce(
    root,
    "scripts/smoke/panel-host/main.tsx",
    'import { gitModule } from "@shep/module-git";\n',
    "",
  );
  replaceOnce(
    root,
    "scripts/smoke/panel-host/main.tsx",
    "await gitModule.projectLifecycle.onProjectsChanged([PROJECT_PATH]);\n",
    "",
  );
  replaceOnce(
    root,
    "scripts/smoke/panel-host/main.tsx",
    "gitModule.panels[0].id",
    '"core.commands"',
  );
  replaceOnce(
    root,
    "scripts/smoke/panel-host/main.tsx",
    `      case "plugin:shep-git|git_status":
        return {
          is_git_repo: true,
          branch: "smoke/panel-host",
          dirty: true,
          staged: 0,
          unstaged: 1,
          untracked: 0,
          ahead: 0,
          behind: 0,
          worktree_parent: null,
        };
      case "plugin:shep-git|git_changed_files":
        return [
          {
            path: "src/AppShell.tsx",
            status: "M",
            area: "unstaged",
            old_path: null,
          },
        ];
      case "plugin:shep-git|git_list_files":
        return ["README.md", "src/AppShell.tsx", "src/core/modules/PanelHost.tsx"];
      case "plugin:shep-git|git_file_contents":
        return "Panel host smoke fixture";
      case "plugin:shep-git|git_file_diff":
        return "@@ -1 +1 @@\\n-old\\n+new";
`,
    "",
  );
}

function prepareDisabled(root) {
  removeFrontendComposition(root);
}

function prepareSourceAbsent(root) {
  prepareDisabled(root);
  removeNativeComposition(root);
  removeSmokeDependency(root);

  rmSync(path.join(root, "modules/git"), { recursive: true, force: true });
  rmSync(path.join(root, "profiles/git-disabled"), { recursive: true, force: true });
  rmSync(path.join(root, "scripts/tests/gitCharacterization.test.ts"), { force: true });
  rmSync(path.join(root, "src-tauri/src/git.rs"), { force: true });

  const packageJson = readJson(root, "package.json");
  delete packageJson.dependencies["@shep/module-git"];
  delete packageJson.scripts["test:git-characterization"];
  delete packageJson.scripts["verify:git-native-disabled"];
  delete packageJson.scripts["verify:git-frontend-disabled"];
  delete packageJson.scripts["verify:git-plugout"];
  packageJson.scripts["verify:todos-native-disabled"] = packageJson.scripts[
    "verify:todos-native-disabled"
  ].replace(",git-module", "");
  packageJson.scripts["verify:ports-native-disabled"] = packageJson.scripts[
    "verify:ports-native-disabled"
  ].replace(",git-module", "");
  packageJson.scripts["verify:skills-native-disabled"] = packageJson.scripts[
    "verify:skills-native-disabled"
  ].replace(",git-module", "");
  writeJson(root, "package.json", packageJson);

  for (const configPath of [
    "src-tauri/tauri.conf.json",
    "profiles/todos-disabled/tauri.conf.json",
    "profiles/ports-disabled/tauri.conf.json",
    "profiles/skills-disabled/tauri.conf.json",
  ]) {
    removeGitCapability(root, configPath);
  }
}

function assertSourceAbsent(root) {
  const patterns = [
    "@shep/module-git",
    "shep_module_git",
    "shep-module-git",
    "tauri-plugin-shep-git",
    "plugin:shep-git",
    "shep-git:allow",
    "git-module",
    "core.git",
    "git.project-",
    "git.settings",
    "GitPanel",
    "GitStatusRow",
    "useGitStore",
    "useGitPanelStore",
  ];
  const targets = [
    "src",
    "src-tauri/src",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "package.json",
    "scripts/smoke/panel-host/main.tsx",
  ];
  const result = spawnSync("rg", ["-n", patterns.join("|"), ...targets], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error(`Git module reference remains after plug-out:\n${result.stdout}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || `rg exited with status ${result.status}`);
  }
}

function verifyEnabled(root) {
  run("pnpm", ["test:git-characterization"], root);
  run("pnpm", ["test:project-surfaces"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root);
}

function verifyDisabled(root) {
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:project-actions"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["build"], root);
  run("pnpm", [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    "profiles/git-disabled/tauri.conf.json",
    "--",
    "--no-default-features",
    "--features",
    "todos-module,ports-module,skills-module",
  ], root);
}

function verifySourceAbsent(root) {
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:project-actions"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root);
}

verifyModulePlugout({
  repositoryRoot,
  moduleName: "git",
  packages: {
    pnpm: "@shep/module-git",
    cargo: "tauri-plugin-shep-git",
  },
  verifyEnabled,
  prepareDisabled,
  verifyDisabled,
  prepareSourceAbsent,
  assertSourceAbsent,
  verifySourceAbsent,
  sourceAbsentOnly: process.argv.includes("--source-absent-only"),
});
