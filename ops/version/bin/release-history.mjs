import { execFileSync } from "node:child_process";

// Product releases use stable SemVer only. Prerelease identifiers belong to a
// separate delivery policy; allowing them here would make the release ledger
// ambiguous.
export const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function components(version) {
  const match = version.match(STABLE_SEMVER);
  if (!match) throw new Error(`not a stable SemVer value: ${JSON.stringify(version)}`);
  return match.slice(1);
}

function compareNumberStrings(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareStableVersions(left, right) {
  const leftComponents = components(left);
  const rightComponents = components(right);
  for (let index = 0; index < leftComponents.length; index += 1) {
    const comparison = compareNumberStrings(leftComponents[index], rightComponents[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function latestStableVersion(versions) {
  const stableVersions = versions.filter((version) => STABLE_SEMVER.test(version));
  if (stableVersions.length === 0) return null;
  return stableVersions.reduce((latest, version) => (
    latest === null || compareStableVersions(version, latest) > 0 ? version : latest
  ), null);
}

export function nextStableVersion(version, part) {
  const [major, minor, patch] = components(version).map((component) => BigInt(component));
  if (part === "patch") return `${major}.${minor}.${patch + 1n}`;
  if (part === "minor") return `${major}.${minor + 1n}.0`;
  if (part === "major") return `${major + 1n}.0.0`;
  throw new Error(`unknown release part: ${JSON.stringify(part)}`);
}

export function localReleaseVersions(root) {
  let output;
  try {
    output = execFileSync("git", ["-C", root, "tag", "--list", "v*"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Unit tests and external consumers can validate a standalone directory.
    // Do not hide a missing Git executable or another operational error.
    if (error?.status === 128 && String(error.stderr).includes("not a git repository")) return [];
    throw error;
  }

  return [...new Set(
    output
      .split("\n")
      .map((tag) => tag.trim())
      .filter((tag) => /^v/.test(tag))
      .map((tag) => tag.slice(1))
      .filter((version) => STABLE_SEMVER.test(version)),
  )].sort(compareStableVersions);
}

export function latestLocalReleaseVersion(root) {
  return latestStableVersion(localReleaseVersions(root));
}
