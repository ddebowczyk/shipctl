import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
let vite;
let policy;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: ROOT,
    server: { hmr: false, middlewareMode: true },
  });
  policy = await vite.ssrLoadModule(
    "/modules/assistants/frontend/src/assistantProviderPolicy.ts",
  );
});

after(async () => {
  await vite?.close();
});

function normalizedPath(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Controlled semantic oracle for the former native Codex capture selection. */
function nativeCaptureOracle(knownPaths, launchRepoPath, files) {
  const candidates = [];
  for (const { relativePath, content } of files) {
    if (knownPaths.has(relativePath)) continue;
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = row?.type === "session_meta" ? row.payload : null;
      if (typeof payload?.id !== "string" || payload.id.length === 0
        || typeof payload?.cwd !== "string" || payload.cwd.length === 0) continue;
      if (normalizedPath(payload.cwd) === normalizedPath(launchRepoPath)) {
        candidates.push(payload.id);
      }
      break;
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  throw new Error("ambiguous capture candidate");
}

function outcome(select) {
  try {
    return { value: select() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const CASES = Object.freeze([
  {
    known: new Set(["old.jsonl"]),
    cwd: "/workspace/repo",
    files: [
      { relativePath: "old.jsonl", content: '{"type":"session_meta","payload":{"id":"old","cwd":"/workspace/repo"}}' },
      { relativePath: "new.jsonl", content: '{"type":"session_meta","payload":{"id":"new","cwd":"/workspace/repo"}}' },
    ],
  },
  {
    known: new Set(),
    cwd: "/workspace/repo",
    files: [{ relativePath: "incomplete.jsonl", content: '{"type":"turn_context","payload":{}}' }],
  },
  {
    known: new Set(),
    cwd: "/workspace/repo/",
    files: [{ relativePath: "normalized.jsonl", content: '{"type":"session_meta","payload":{"id":"normalized","cwd":"/workspace/repo"}}' }],
  },
  {
    known: new Set(),
    cwd: "/workspace/repo",
    files: [
      { relativePath: "first.jsonl", content: '{"type":"session_meta","payload":{"id":"first","cwd":"/workspace/repo"}}' },
      { relativePath: "second.jsonl", content: '{"type":"session_meta","payload":{"id":"second","cwd":"/workspace/repo"}}' },
    ],
  },
]);

test("architecture.assistant-capture-measurement", () => {
  for (const fixture of CASES) {
    const baseline = outcome(() => nativeCaptureOracle(fixture.known, fixture.cwd, fixture.files));
    const plugin = outcome(() => policy.selectCodexCaptureIdentity(
      fixture.known,
      fixture.cwd,
      fixture.files,
    ));
    assert.equal(plugin.value, baseline.value);
    assert.equal(plugin.error === undefined, baseline.error === undefined);
  }

  const benchmarkFiles = Array.from({ length: 32 }, (_, index) => ({
    relativePath: `new-${index}.jsonl`,
    content: index === 31
      ? '{"type":"session_meta","payload":{"id":"measured","cwd":"/workspace/repo"}}'
      : '{"type":"turn_context","payload":{"model":"test"}}',
  }));
  const iterations = 4_000;
  const baselineStarted = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    assert.equal(nativeCaptureOracle(new Set(), "/workspace/repo", benchmarkFiles), "measured");
  }
  const baselineMs = performance.now() - baselineStarted;
  const pluginStarted = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    assert.equal(policy.selectCodexCaptureIdentity(new Set(), "/workspace/repo", benchmarkFiles), "measured");
  }
  const pluginMs = performance.now() - pluginStarted;
  assert.ok(pluginMs <= Math.max(100, baselineMs * 50 + 10));

  const runtimeSource = readFileSync(
    `${ROOT}/modules/assistants/frontend/src/runtime.ts`,
    "utf8",
  );
  const retryMs = Number(runtimeSource.match(/const CAPTURE_RETRY_MS = (\d+);/)?.[1]);
  const maxAttempts = Number(runtimeSource.match(/const CAPTURE_MAX_ATTEMPTS = (\d+);/)?.[1]);
  assert.equal(retryMs, 500);
  assert.equal(maxAttempts, 20);
  const retryWindowMs = retryMs * (maxAttempts - 1);
  assert.equal(retryWindowMs, 9_500);
  console.log(JSON.stringify({
    capture_measurement: {
      fixtures: CASES.length,
      iterations,
      baseline_ms: Number(baselineMs.toFixed(3)),
      plugin_ms: Number(pluginMs.toFixed(3)),
      retry_ms: retryMs,
      max_attempts: maxAttempts,
      retry_window_ms: retryWindowMs,
    },
  }));
});
