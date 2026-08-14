#!/usr/bin/env node

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { plugout, readManifest } from "./plugout.mjs";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const ids = readdirSync(path.join(root, "modules"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((id) => readManifest(root, id).frontend?.composition_symbol)
  .sort();

for (const id of ids) {
  plugout(root, id);
}
