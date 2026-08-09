import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function field(hash, name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(Buffer.from(`${name}\0${bytes.length}\0`));
  hash.update(bytes);
  hash.update(Buffer.from("\0"));
}

function entries(root, relative = "") {
  const directory = path.join(root, relative);
  return readdirSync(directory).sort().flatMap((name) => {
    const child = path.join(relative, name);
    const stat = lstatSync(path.join(root, child));
    return stat.isDirectory() ? [child, ...entries(root, child)] : [child];
  });
}

export function hashTree(root) {
  const hash = createHash("sha256");
  field(hash, "format", "shipctl-artifact-tree-v1");
  for (const relative of entries(root)) {
    const absolute = path.join(root, relative);
    const stat = lstatSync(absolute);
    field(hash, "path", relative);
    field(hash, "mode", (stat.mode & 0o7777).toString(8));
    if (stat.isDirectory()) field(hash, "directory", "");
    else if (stat.isSymbolicLink()) field(hash, "symlink", readlinkSync(absolute));
    else if (stat.isFile()) field(hash, "file", readFileSync(absolute));
    else throw new Error(`unsupported artifact entry: ${relative}`);
  }
  return hash.digest("hex");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("usage: node hash-tree.mjs <directory>");
  process.stdout.write(`${hashTree(root)}\n`);
}

