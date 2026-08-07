#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { frontendDisabled, nativeDisabled, plugout, readManifest } from "./plugout.mjs";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const ids = readdirSync(path.join(root, "modules"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "api")
  .map((entry) => entry.name)
  .filter((id) => readManifest(root, id).frontend?.composition_symbol)
  .sort();
const composition = readFileSync(path.join(root, "core/frontend/host/enabledModules.ts"), "utf8");

for (const id of ids) {
  const manifest = readManifest(root, id);
  plugout(root, id);
  const envName = `VITE_SHEP_${id.toUpperCase().replaceAll("-", "_")}_MODULE`;
  if (composition.includes(`import.meta.env.${envName}`)) frontendDisabled(root, id);
  if (manifest.backend?.cargo_feature && manifest.profile?.includes("-disabled/")) {
    nativeDisabled(root, id);
  }
}
