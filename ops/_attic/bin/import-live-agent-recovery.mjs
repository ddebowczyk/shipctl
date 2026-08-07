#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const recoveryDir = join(homedir(), ".shep", "session-recovery");
const snapshotPath = join(
  recoveryDir,
  "live-agent-sessions-20260803T133534+0200.json",
);
const manifestPath = join(homedir(), ".shep", "assistant-sessions.json");
const providerSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shouldApply = process.argv.includes("--apply");

if (process.argv.some((arg) => arg === "--help" || arg === "-h")) {
  console.log(`Usage: node ops/_attic/bin/import-live-agent-recovery.mjs [--apply]

Converts the one-time live-agent snapshot captured on this Mac into Shep's
assistant restore manifest. Without --apply it only validates and previews.

Run --apply only after the original /Applications/shep.app has quit, and before
starting the newly built Shep app. The snapshot stays unchanged.`);
  process.exit(0);
}

function fail(message) {
  console.error(`Recovery import stopped: ${message}`);
  process.exit(1);
}

function parseSnapshot() {
  if (!existsSync(snapshotPath)) {
    fail(`snapshot is missing: ${snapshotPath}`);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    fail(`could not read snapshot: ${error.message}`);
  }

  if (
    snapshot.schema_version !== 1 ||
    snapshot.kind !== "shep-live-agent-recovery-snapshot" ||
    snapshot.status !== "inert-manual-recovery-only" ||
    !Array.isArray(snapshot.records)
  ) {
    fail("snapshot does not have the expected one-time recovery format");
  }

  return snapshot;
}

function sourceAppIsStillRunning(snapshot) {
  if (!Number.isInteger(snapshot.source_application_pid) || !snapshot.source_application) {
    fail("snapshot has no source application PID guard");
  }

  const result = spawnSync(
    "/bin/ps",
    ["-p", String(snapshot.source_application_pid), "-o", "comm="],
    { encoding: "utf8" },
  );
  const command = result.status === 0 ? result.stdout.trim() : "";
  return command === snapshot.source_application;
}

function recoverableRecords(snapshot) {
  const seenProviderSessionIds = new Set();
  const skipped = [];
  const records = [];

  for (const [index, source] of snapshot.records.entries()) {
    if (!source.provider_session_id) {
      skipped.push({ index, reason: "no captured provider session ID" });
      continue;
    }
    if (source.provider !== "claude" && source.provider !== "codex") {
      fail(`record ${index + 1} has an unsupported provider`);
    }
    if (!providerSessionIdPattern.test(source.provider_session_id)) {
      fail(`record ${index + 1} has an invalid provider session ID`);
    }
    if (seenProviderSessionIds.has(source.provider_session_id)) {
      fail(`record ${index + 1} duplicates a provider session ID`);
    }
    seenProviderSessionIds.add(source.provider_session_id);

    try {
      records.push({
        recordId: randomUUID(),
        provider: source.provider,
        providerSessionId: source.provider_session_id,
        launchRepoPath: realpathSync(source.launch_repo_path),
        placementProjectPath: realpathSync(source.placement_project_path),
        label: `${source.provider === "claude" ? "Claude" : "Codex"} · ${basename(source.launch_repo_path)} · ${source.provider_session_id.slice(0, 8)}`,
        sessionMode: "standard",
        model: null,
        captureState: "ready",
        restoreOnNextLaunch: true,
        startedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      fail(`record ${index + 1} refers to a missing directory: ${error.message}`);
    }
  }

  return { records, skipped };
}

function writeManifest(records) {
  if (existsSync(manifestPath)) {
    fail(`restore manifest already exists: ${manifestPath}. Refusing to merge or overwrite it.`);
  }

  const manifest = JSON.stringify({ version: 1, sessions: records }, null, 2) + "\n";
  const parent = dirname(manifestPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const temporaryPath = join(parent, `.assistant-sessions.import-${process.pid}.json`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeSync(descriptor, manifest);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, manifestPath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    fail(`could not write restore manifest: ${error.message}`);
  }
}

const snapshot = parseSnapshot();
const originalShepIsRunning = sourceAppIsStillRunning(snapshot);
if (shouldApply && originalShepIsRunning) {
  fail(`the original Shep is still running (PID ${snapshot.source_application_pid}). Quit it before importing.`);
}

const { records, skipped } = recoverableRecords(snapshot);
console.log(`Snapshot: ${snapshotPath}`);
console.log(`Provider sessions ready for import: ${records.length}`);
for (const record of records) {
  console.log(
    `  ${record.provider}: ${record.providerSessionId.slice(0, 8)}… → ${record.placementProjectPath}`,
  );
}
for (const skippedRecord of skipped) {
  console.log(`Skipped record ${skippedRecord.index + 1}: ${skippedRecord.reason}`);
}

if (!shouldApply) {
  if (originalShepIsRunning) {
    console.log("The original Shep is still running, so this remains a validation-only preview.");
  }
  console.log("Dry run only. Re-run with --apply after quitting the original Shep.");
  process.exit(0);
}

writeManifest(records);
console.log(`Imported ${records.length} provider sessions into ${manifestPath}`);
console.log("Now start the newly built Shep once; it will issue the provider-specific resume commands.");
