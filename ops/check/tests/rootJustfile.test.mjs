import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("the root justfile imports only available operation modules", async () => {
  const { stdout } = await exec("just", ["--list", "--unsorted"], {
    cwd: repositoryRoot,
  });
  assert.match(stdout, /architecture/);
  assert.match(stdout, /check/);
});
