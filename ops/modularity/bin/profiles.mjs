#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readManifest } from "./plugout.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export function expectedProfiles(root) {
  const base = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const capabilities = base.app.security.capabilities;
  const profiles = new Map();
  for (const entry of readdirSync(path.join(root, "modules"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestFile = path.join(root, "modules", entry.name, "module.yaml");
    if (!existsSync(manifestFile)) continue;
    const manifest = readManifest(root, entry.name);
    if (!manifest.profile?.includes("-disabled/")) continue;
    const config = {
      app: {
        security: {
          capabilities: capabilities.filter(
            (capability) =>
              typeof capability !== "object" ||
              capability.identifier !== manifest.tauri.capability_identifier,
          ),
        },
      },
    };
    profiles.set(manifest.profile, `${JSON.stringify(config, null, 2)}\n`);
  }
  return profiles;
}

export function profileDrift(root) {
  const drift = [];
  for (const [relativePath, expected] of expectedProfiles(root)) {
    const file = path.join(root, relativePath);
    const actual = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (actual !== expected) drift.push(relativePath);
  }
  return drift;
}

export function profilesSync(root) {
  for (const [relativePath, content] of expectedProfiles(root)) {
    writeFileSync(path.join(root, relativePath), content);
  }
}

const command = process.argv[2];
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (command === "check") {
    const drift = profileDrift(repositoryRoot);
    if (drift.length > 0) {
      throw new Error(`Generated module profiles are stale:\n${drift.map((file) => `  - ${file}`).join("\n")}`);
    }
    process.stdout.write("Generated module profiles match the manifests.\n");
  } else if (command === "sync") {
    profilesSync(repositoryRoot);
    process.stdout.write("Generated module profiles synchronized.\n");
  } else {
    throw new Error("Usage: profiles.mjs <check|sync>");
  }
}
