import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const files = globSync([
  "core/backend/src/**/*.rs",
  "core/frontend/**/*.{ts,tsx}",
  "modules/*/backend/src/**/*.rs",
  "src-tauri/src/**/*.rs",
], { cwd: root, exclude: ["**/workspace/migration.rs"] });

const forbidden = [
  [/\.join\(["']\.shipctl(?:\/[^"']*)?["']\)/, "literal default-profile join"],
  [/static\s+CONFIG_CACHE\b/, "process-global workspace cache"],
  [/localStorage\.(?:getItem|setItem)\(["']shipctl:/, "instance preference in webview localStorage"],
  [/UsageDb::open\(\)/, "usage database without an injected path"],
  [/AssistantSessionRegistry::new\(\)/, "assistant registry without an injected path"],
];

const violations = [];
for (const file of files) {
  const path = resolve(root, file);
  const source = readFileSync(path, "utf8").split("#[cfg(test)]")[0];
  for (const [pattern, reason] of forbidden) {
    const match = pattern.exec(source);
    if (!match) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${relative(root, path)}:${line}: ${reason}`);
  }
}

if (violations.length > 0) {
  console.error("Instance-path ownership violations:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Instance-path ownership OK (${files.length} production files scanned)`);
}
