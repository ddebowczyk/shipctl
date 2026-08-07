import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "../../..");
const verdicts = ["pending", "adopt", "adapt", "reject", "n-a"];

async function command(program, args, cwd) {
  const { stdout = "" } = await exec(program, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function today() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function quote(value) {
  return JSON.stringify(String(value));
}

export function frontmatterSource(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("ledger entry has no YAML frontmatter");
  return match[1];
}

export function parseFrontmatter(markdown) {
  const source = frontmatterSource(markdown);
  const result = {};
  let sequenceKey = null;
  for (const line of source.split(/\r?\n/)) {
    const sequenceItem = line.match(/^\s+-\s+(.+)$/);
    if (sequenceItem && sequenceKey) {
      result[sequenceKey].push(parseScalar(sequenceItem[1]));
      continue;
    }
    const match = line.match(/^([a-z_]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const [, key, raw = ""] = match;
    const value = raw.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      result[key] = inner ? inner.split(",").map((item) => parseScalar(item.trim())) : [];
      sequenceKey = null;
    } else if (!value) {
      result[key] = [];
      sequenceKey = key;
    } else {
      result[key] = parseScalar(value);
      sequenceKey = null;
    }
  }
  return result;
}

function parseScalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function validateQueueEntry(commit, entry) {
  if (entry.upstream !== commit.short) {
    throw new Error(`${commit.short}: ledger upstream is ${entry.upstream ?? "missing"}`);
  }
  if (entry.subject !== commit.subject) throw new Error(`${commit.short}: ledger subject drifted`);
  if (entry.authored !== commit.authored) throw new Error(`${commit.short}: ledger authored date drifted`);
  if (!verdicts.includes(entry.verdict)) throw new Error(`${commit.short}: invalid verdict ${entry.verdict ?? "missing"}`);
}

export function assertClosable(commits, entries) {
  for (const commit of commits) {
    const entry = entries.get(commit.short);
    if (!entry) throw new Error(`${commit.short}: ledger entry is missing`);
    validateQueueEntry(commit, entry);
    if (entry.verdict === "pending") throw new Error(`${commit.short}: verdict is pending`);
    if (["adopt", "adapt"].includes(entry.verdict)) {
      if (!entry.integration || !["replace", "variant", "new"].includes(entry.integration)) {
        throw new Error(`${commit.short}: ${entry.verdict} requires integration`);
      }
      if (!Array.isArray(entry.bd) || entry.bd.length === 0) {
        throw new Error(`${commit.short}: ${entry.verdict} requires a bd issue`);
      }
    }
  }
}

function pendingEntry(commit) {
  return [
    "---",
    `upstream: ${quote(commit.short)}`,
    `subject: ${quote(commit.subject)}`,
    `authored: ${quote(commit.authored)}`,
    "verdict: pending",
    "---",
    "",
  ].join("\n");
}

function parseLog(output) {
  return output.split("\0").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [full, short, authored, ...subject] = record.split("\x1f");
    return { full, short, authored, subject: subject.join("\x1f") };
  });
}

async function refs(root) {
  const watermark = (await command("git", ["rev-parse", "upstream-reviewed^{commit}"], root)).trim();
  const upstreamHead = (await command("git", ["rev-parse", "upstream/main^{commit}"], root)).trim();
  return { watermark, upstreamHead, range: `${watermark}..${upstreamHead}` };
}

async function queue(root) {
  const current = await refs(root);
  const output = await command("git", [
    "log", "--no-merges", "--reverse", "-z", "--date=short",
    "--format=%H%x1f%h%x1f%ad%x1f%s", current.range,
  ], root);
  return { ...current, commits: parseLog(output) };
}

async function ledger(root) {
  const logDirectory = path.join(root, "ops/upstream/log");
  await mkdir(logDirectory, { recursive: true });
  const files = (await readdir(logDirectory)).filter((name) => name.endsWith(".md")).sort();
  const entries = new Map();
  for (const file of files) {
    const markdown = await readFile(path.join(logDirectory, file), "utf8");
    const entry = parseFrontmatter(markdown);
    const expectedName = `${entry.upstream}.md`;
    if (file !== expectedName) throw new Error(`${file}: expected filename ${expectedName}`);
    if (entries.has(entry.upstream)) throw new Error(`${file}: duplicate ledger entry`);
    entries.set(entry.upstream, entry);
  }
  return entries;
}

async function readYaml(root, relative) {
  const file = path.join(root, relative);
  return JSON.parse(await command("yq", ["-o=json", ".", file], root));
}

function renderState(state) {
  const lines = [
    "---",
    `upstream_remote: ${state.upstream_remote}`,
    `watermark_ref: ${state.watermark_ref}`,
    `last_fetch: ${quote(state.last_fetch)}`,
    `last_upstream_head: ${state.last_upstream_head}`,
    `last_upstream_tag: ${state.last_upstream_tag}`,
  ];
  if (!state.batches.length) lines.push("batches: []");
  else {
    lines.push("batches:");
    for (const batch of state.batches) {
      lines.push(`  - date: ${quote(batch.date)}`);
      lines.push(`    range: ${batch.range}`);
      for (const key of ["commits_total", "merges_skipped", "triaged", "n_a", "adopt", "adapt", "reject", "pending"]) {
        lines.push(`    ${key}: ${batch[key]}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

async function writeState(root, state) {
  const file = path.join(root, "ops/upstream/state.yaml");
  const temporary = `${file}.tmp`;
  await writeFile(temporary, renderState(state));
  await command("ys", ["-f", path.join(root, "ops/upstream/schema/state.schema.yaml"), temporary], root);
  await rename(temporary, file);
}

function globRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

async function fetchCommand(root) {
  await command("git", ["fetch", "upstream", "--tags"], root);
  const state = await readYaml(root, "ops/upstream/state.yaml");
  state.last_fetch = today();
  state.last_upstream_head = (await command("git", ["rev-parse", "--short", "upstream/main"], root)).trim();
  state.last_upstream_tag = (await command("git", ["describe", "--tags", "--abbrev=0", "upstream/main"], root)).trim();
  await writeState(root, state);
  process.stdout.write(`${state.last_upstream_head} ${state.last_upstream_tag}\n`);
}

async function queueCommand(root) {
  const current = await queue(root);
  for (const commit of current.commits) process.stdout.write(`${commit.short} ${commit.subject}\n`);
}

async function stubCommand(root) {
  const current = await queue(root);
  const entries = await ledger(root);
  let created = 0;
  for (const commit of current.commits) {
    const existing = entries.get(commit.short);
    if (existing) validateQueueEntry(commit, existing);
    else {
      await writeFile(path.join(root, "ops/upstream/log", `${commit.short}.md`), pendingEntry(commit), { flag: "wx" });
      created += 1;
    }
  }
  process.stdout.write(`${created} created; ${current.commits.length - created} already present\n`);
}

async function triageCommand(root, sha) {
  if (!sha) throw new Error("triage requires a sha");
  const current = await queue(root);
  const commit = current.commits.find((candidate) => candidate.short === sha || candidate.full === sha);
  if (!commit) throw new Error(`${sha}: not in the current non-merge queue`);
  const stat = await command("git", ["show", "--stat", "--format=", commit.full], root);
  process.stdout.write(stat);
  const changed = (await command("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", commit.full], root))
    .split(/\r?\n/).filter(Boolean);
  const pathMap = await readYaml(root, "ops/upstream/path-map.yaml");
  for (const changedPath of changed) {
    const mapping = pathMap.paths.find(({ glob }) => globRegex(glob).test(changedPath));
    process.stdout.write(`${changedPath}\t${mapping?.status ?? "unknown"}\n`);
  }
}

async function statusCommand(root) {
  const entries = await ledger(root);
  const current = await queue(root);
  const counts = Object.fromEntries(verdicts.map((verdict) => [verdict, 0]));
  for (const entry of entries.values()) {
    if (!(entry.verdict in counts)) throw new Error(`${entry.upstream}: invalid verdict ${entry.verdict}`);
    counts[entry.verdict] += 1;
  }
  process.stdout.write(`queue: ${current.commits.length}\n`);
  for (const verdict of verdicts) process.stdout.write(`${verdict}: ${counts[verdict]}\n`);
}

async function closeCommand(root) {
  const current = await queue(root);
  if (!current.commits.length) {
    process.stdout.write("queue already closed\n");
    return;
  }
  const entries = await ledger(root);
  assertClosable(current.commits, entries);
  const total = Number((await command("git", ["rev-list", "--count", current.range], root)).trim());
  const counts = Object.fromEntries(verdicts.map((verdict) => [verdict, 0]));
  for (const commit of current.commits) counts[entries.get(commit.short).verdict] += 1;
  const state = await readYaml(root, "ops/upstream/state.yaml");
  state.last_upstream_head = current.upstreamHead.slice(0, 7);
  state.batches.push({
    date: today(),
    range: `${current.watermark.slice(0, 7)}..${current.upstreamHead.slice(0, 7)}`,
    commits_total: total,
    merges_skipped: total - current.commits.length,
    triaged: current.commits.length,
    n_a: counts["n-a"],
    adopt: counts.adopt,
    adapt: counts.adapt,
    reject: counts.reject,
    pending: counts.pending,
  });
  const stateFile = path.join(root, "ops/upstream/state.yaml");
  const previousState = await readFile(stateFile, "utf8");
  await command("git", ["update-ref", "refs/heads/upstream-reviewed", current.upstreamHead, current.watermark], root);
  try {
    await writeState(root, state);
  } catch (error) {
    await command("git", ["update-ref", "refs/heads/upstream-reviewed", current.watermark, current.upstreamHead], root);
    await writeFile(stateFile, previousState);
    throw error;
  }
  process.stdout.write(`closed ${state.batches.at(-1).range}\n`);
}

export async function run(args = process.argv.slice(2), root = defaultRoot) {
  const [name, ...rest] = args;
  const commands = {
    fetch: () => fetchCommand(root),
    queue: () => queueCommand(root),
    stub: () => stubCommand(root),
    triage: () => triageCommand(root, rest[0]),
    status: () => statusCommand(root),
    close: () => closeCommand(root),
  };
  if (!commands[name]) throw new Error(`unknown upstream command: ${name ?? "missing"}`);
  await commands[name]();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`upstream: ${error.message}\n`);
    process.exitCode = 1;
  });
}
