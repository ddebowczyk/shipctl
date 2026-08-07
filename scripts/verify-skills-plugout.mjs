#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  nativeModuleFeaturesExcept,
  readJson,
  removeCargoDefaultFeature,
  removeFrontendModuleComposition,
  replaceOnce,
  run,
  verifyModulePlugout,
  writeJson,
} from "./lib/module-plugout.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function removeFrontendComposition(root) {
  removeFrontendModuleComposition(root, "@shep/module-skills", "skillsModule");
}

function removeNativeComposition(root) {
  removeCargoDefaultFeature(root, "skills-module");
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'skills-module = ["dep:shep-module-skills"]\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'shep-module-skills = { package = "tauri-plugin-shep-skills", path = "../modules/skills/backend", optional = true }\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/enabled_modules.rs",
    '    #[cfg(feature = "skills-module")]\n    let builder = builder.plugin(shep_module_skills::init(\n        crate::skills_module::host_services(),\n    ));\n\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/lib.rs",
    '#[cfg(feature = "skills-module")]\nmod skills_module;\n',
    "",
  );
  rmSync(path.join(root, "src-tauri/src/skills_module.rs"), { force: true });
}

function removeSkillsCapability(root, relativePath) {
  if (!existsSync(path.join(root, relativePath))) return;
  const config = readJson(root, relativePath);
  const capabilities = config.app?.security?.capabilities;
  if (Array.isArray(capabilities)) {
    config.app.security.capabilities = capabilities.filter(
      (capability) => typeof capability !== "object" || capability?.identifier !== "skills",
    );
  }
  writeJson(root, relativePath, config);
}

function removeSmokeDependency(root) {
  replaceOnce(
    root,
    "scripts/smoke/panel-host/main.tsx",
    'import { skillsModule } from "@shep/module-skills";\n',
    "",
  );
  replaceOnce(
    root,
    "scripts/smoke/panel-host/main.tsx",
    "await skillsModule.projectLifecycle.onProjectsChanged([PROJECT_PATH]);\n",
    "",
  );
  replaceOnce(
    root,
    "scripts/smoke/panel-host/main.tsx",
    '      case "plugin:shep-skills|list_skills":\n        return [\n          {\n            name: "shep-todos",\n            title: "Shep to-dos",\n            description: "Smoke fixture",\n            installed: true,\n          },\n        ];\n',
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

  rmSync(path.join(root, "modules/skills"), { recursive: true, force: true });
  rmSync(path.join(root, "profiles/skills-disabled"), { recursive: true, force: true });

  const packageJson = readJson(root, "package.json");
  delete packageJson.dependencies["@shep/module-skills"];
  delete packageJson.scripts["test:skills-characterization"];
  delete packageJson.scripts["verify:skills-native-disabled"];
  delete packageJson.scripts["verify:skills-plugout"];
  packageJson.scripts["verify:todos-native-disabled"] = packageJson.scripts[
    "verify:todos-native-disabled"
  ].replace("ports-module,skills-module", "ports-module");
  packageJson.scripts["verify:ports-native-disabled"] = packageJson.scripts[
    "verify:ports-native-disabled"
  ].replace("todos-module,skills-module", "todos-module");
  writeJson(root, "package.json", packageJson);

  removeSkillsCapability(root, "src-tauri/tauri.conf.json");
}

function assertSourceAbsent(root) {
  const patterns = [
    "@shep/module-skills",
    "shep_module_skills",
    "shep-module-skills",
    "tauri-plugin-shep-skills",
    "plugin:shep-skills",
    "shep-skills:allow",
    "skills-module",
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
    throw new Error(`Skills module reference remains after plug-out:\n${result.stdout}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || `rg exited with status ${result.status}`);
  }
}

function verifyEnabled(root) {
  run("pnpm", ["test:skills-characterization"], root);
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:project-actions"], root);
  run("pnpm", ["test:todos-characterization"], root);
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
  run("pnpm", ["test:todos-characterization"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["build"], root);
  run("pnpm", [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    "profiles/skills-disabled/tauri.conf.json",
    "--",
    "--no-default-features",
    "--features",
    nativeModuleFeaturesExcept("skills-module"),
  ], root);
}

function verifySourceAbsent(root) {
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:project-actions"], root);
  run("pnpm", ["test:todos-characterization"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root);
}

verifyModulePlugout({
  repositoryRoot,
  moduleName: "skills",
  packages: {
    pnpm: "@shep/module-skills",
    cargo: "tauri-plugin-shep-skills",
  },
  verifyEnabled,
  prepareDisabled,
  verifyDisabled,
  prepareSourceAbsent,
  assertSourceAbsent,
  verifySourceAbsent,
  sourceAbsentOnly: process.argv.includes("--source-absent-only"),
});
