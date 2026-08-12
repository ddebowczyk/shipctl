import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SOURCE_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".mts", ".cts", ".toml"]);
const INVENTORY_TARGETS = [
  {
    id: "core-frontend-terminal",
    root: "core/frontend",
    pattern: /(?:from\s+["']|import\s*\(["'])@shipctl\/core\/terminal(?:["'/])|\.\.\/terminal\//g,
  },
  {
    id: "core-backend-terminal",
    root: "core/backend/src",
    pattern: /(?:crate::terminal::|super::terminal::)/g,
  },
  { id: "xterm", root: ".", pattern: /@xterm\//g },
  { id: "ghostty", root: ".", pattern: /libghostty-vt/g },
  { id: "terminal-transport", root: ".", pattern: /TerminalTransport/g },
];

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name === ".git") continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
  }
  return files;
}

function matches(text, pattern) {
  const found = [];
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(0, match.index);
    found.push({
      line: before.split("\n").length,
      match: match[0],
    });
  }
  return found;
}

/**
 * List implementation dependencies and retired compatibility references.
 * The corresponding test asserts the expected module owners and absence of
 * the retired core boundary.
 */
export async function terminalExtractionInventory(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const inventory = [];
  for (const target of INVENTORY_TARGETS) {
    const files = await sourceFiles(path.join(absoluteRoot, target.root));
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      for (const occurrence of matches(contents, target.pattern)) {
        inventory.push({
          target: target.id,
          file: path.relative(absoluteRoot, file),
          ...occurrence,
        });
      }
    }
  }
  return inventory.sort((left, right) =>
    left.target.localeCompare(right.target)
    || left.file.localeCompare(right.file)
    || left.line - right.line,
  );
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  console.log(JSON.stringify(await terminalExtractionInventory(), null, 2));
}
