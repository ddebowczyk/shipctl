import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export function discoverAggregateCommands(root, aggregate) {
  const opsRoot = resolve(root, "ops");
  const commands = [];

  for (const entry of readdirSync(opsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = resolve(opsRoot, entry.name, "capability.yaml");
    if (!existsSync(manifest)) continue;
    const capability = JSON.parse(
      execFileSync("yq", ["-o=json", ".", manifest], { encoding: "utf8" }),
    );

    for (const command of capability.commands ?? []) {
      if (command.lane !== "fast" || command.aggregate !== aggregate) continue;
      if (command.args?.length) {
        throw new Error(
          `${capability.id}.${command.name} cannot join ${aggregate}: aggregate commands take no arguments`,
        );
      }
      commands.push({ capability: capability.id, command: command.name });
    }
  }

  return commands.sort((left, right) =>
    `${left.capability}.${left.command}`.localeCompare(`${right.capability}.${right.command}`),
  );
}

export function runAggregate(root, aggregate) {
  const commands = discoverAggregateCommands(root, aggregate);
  for (const { capability, command } of commands) {
    console.log(`==> just ${capability} ${command}`);
    const result = spawnSync("just", [capability, command], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = runAggregate(repositoryRoot, process.argv[2] ?? "check");
}
