import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const baseline = JSON.parse(
  await readFile(new URL("../baselines/clippy.json", import.meta.url), "utf8"),
);
const args = ["clippy", "--workspace", "--all-targets", "--message-format=json"];
const child = spawn("cargo", args, {
  stdio: ["inherit", "pipe", "inherit"],
});

let warningCount = 0;
const warningCodes = new Map();
const lines = createInterface({ input: child.stdout });

for await (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    continue;
  }

  if (event.reason !== "compiler-message" || event.message?.level !== "warning") {
    continue;
  }

  warningCount += 1;
  const code = event.message.code?.code ?? "uncoded";
  warningCodes.set(code, (warningCodes.get(code) ?? 0) + 1);
}

const exitCode = await new Promise((resolve) => {
  child.once("close", (code) => resolve(code ?? 1));
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  const delta = warningCount - baseline.warning_count;
  const deltaLabel = delta === 0 ? "unchanged" : `${delta > 0 ? "+" : ""}${delta}`;
  console.log(
    `Clippy: ${warningCount} warnings; baseline ${baseline.warning_count} (${deltaLabel})`,
  );
  for (const [code, count] of [...warningCodes].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    console.log(`  ${code}: ${count}`);
  }
}
