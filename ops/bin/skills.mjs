import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function inventorySkills(root = defaultRoot) {
  const opsRoot = path.join(root, "ops");
  const capabilities = await readdir(opsRoot, { withFileTypes: true });
  const inventory = [];

  for (const capability of capabilities.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!await exists(path.join(opsRoot, capability.name, "capability.yaml"))) continue;
    const skillsRoot = path.join(opsRoot, capability.name, "skills");
    if (!await exists(skillsRoot)) continue;
    const skills = await readdir(skillsRoot, { withFileTypes: true });
    for (const skill of skills.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const skillFile = path.join(skillsRoot, skill.name, "SKILL.md");
      if (!await exists(skillFile)) continue;
      const source = await readFile(skillFile, "utf8");
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
      const name = frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1].trim();
      const summary = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1].trim();
      if (!name || !summary) throw new Error(`${path.relative(root, skillFile)} needs name and description frontmatter`);
      inventory.push({
        name,
        capability: capability.name,
        path: path.relative(root, skillFile).split(path.sep).join("/"),
        summary,
      });
    }
  }

  return inventory;
}

export function formatInventory(inventory) {
  const rows = [["NAME", "CAPABILITY", "PATH", "SUMMARY"], ...inventory.map(({ name, capability, path: skillPath, summary }) => [name, capability, skillPath, summary])];
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  return rows.map((row) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd()).join("\n");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const inventory = await inventorySkills();
  console.log(formatInventory(inventory));
}
