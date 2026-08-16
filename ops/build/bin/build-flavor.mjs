#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const RELEASE = Object.freeze({
  appName: "shipctl",
  bundleIdentifier: "com.cognesy.shipctl",
});

const PREVIEW = Object.freeze({
  appName: "shipctl-preview",
  bundleIdentifierPrefix: "com.cognesy.shipctl.preview",
});

function fail(message) {
  throw new Error(message);
}

function previewIdentifier(buildId) {
  if (!/^b\d{8}T\d{6}\.\d{3}Z-g[\da-f]{12}-[tw][\da-f]{12}-[\w.-]+$/.test(buildId)) {
    fail(`Invalid build ID for preview bundle identity: ${buildId}`);
  }
  return `${PREVIEW.bundleIdentifierPrefix}.${buildId.replaceAll(".", "-")}`;
}

/**
 * Tauri configuration for one build artifact class.
 *
 * Preview bundles must never register as the installed Shipctl release. The
 * distinct application name keeps `open -a shipctl` unambiguous, and the
 * unique identifier prevents macOS from coalescing a preview process with the
 * release application or another preview build.
 */
export function buildFlavor(flavor, buildId) {
  let appName;
  let bundleIdentifier;
  switch (flavor) {
    case "package":
      appName = RELEASE.appName;
      bundleIdentifier = RELEASE.bundleIdentifier;
      break;
    case "preview":
      appName = PREVIEW.appName;
      bundleIdentifier = previewIdentifier(buildId);
      break;
    default:
      fail(`Unknown build flavor: ${flavor}`);
  }

  return {
    flavor,
    appName,
    appBundleName: `${appName}.app`,
    bundleIdentifier,
    tauriConfig: {
      productName: appName,
      identifier: bundleIdentifier,
      bundle: { macOS: { signingIdentity: "-" } },
    },
  };
}

function main(arguments_) {
  const [flavor, buildId] = arguments_;
  if (arguments_.length !== 2) {
    fail("Usage: build-flavor.mjs <preview|package> <build-id>");
  }
  process.stdout.write(`${JSON.stringify(buildFlavor(flavor, buildId))}\n`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
  }
}
