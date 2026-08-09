import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 256 * 1024 * 1024 });
}

function field(hash, name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(Buffer.from(`${name}\0${bytes.length}\0`));
  hash.update(bytes);
  hash.update(Buffer.from("\0"));
}

export function sourceIdentity(root = defaultRoot) {
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "buffer");
  const dirty = status.length > 0;
  const hash = createHash("sha256");
  field(hash, "format", "shipctl-source-fingerprint-v1");
  field(hash, "commit", commit);
  field(hash, "tree", tree);

  if (dirty) {
    field(hash, "tracked-diff", git(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], "buffer"));
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"], "buffer")
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    for (const relative of untracked) {
      const absolute = path.join(root, relative);
      const stat = lstatSync(absolute);
      field(hash, "untracked-path", relative);
      if (stat.isSymbolicLink()) field(hash, "untracked-symlink", readlinkSync(absolute));
      else if (stat.isFile()) field(hash, "untracked-file", readFileSync(absolute));
      else field(hash, "untracked-type", stat.mode.toString(8));
    }
  }

  return {
    schema_version: 1,
    commit,
    tree,
    dirty,
    fingerprint_algorithm: "sha256",
    fingerprint: hash.digest("hex"),
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(sourceIdentity(path.resolve(process.argv[2] ?? defaultRoot)))}\n`);
}
