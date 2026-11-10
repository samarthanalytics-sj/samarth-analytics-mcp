#!/usr/bin/env node
// Keep server.json (the MCP Registry manifest) in step with the npm version.
//
// server.json carries the package version in two places: the top-level
// "version", and the "version" of the npm entry under "packages". Both must be
// the version that is on npm, or the registry announces the wrong release.
//
// This script is the "version" lifecycle script in package.json. In a release,
// @semantic-release/npm runs `npm version <next>`. npm writes the new version
// to package.json and package-lock.json, and then runs this script. So
// server.json has the new version before @semantic-release/git makes the
// release commit (server.json is in its "assets" list in .releaserc.json).
//
// It only writes the file. Publishing to the MCP Registry is a separate, manual
// step (see docs/DIRECTORY_LISTINGS.md).
//
// Usage (from the repo root):
//   node scripts/sync-server-json.mjs          # version from package.json
//   node scripts/sync-server-json.mjs 1.2.3    # this version instead
//
// For a file in the standard JSON.stringify layout (like the committed
// server.json) only the version values change. The indentation width and the
// final newline are kept. Other formatting is normalised: for example a
// minified file comes back pretty-printed, and CRLF line ends become LF. A run
// that has nothing to change does not write the file.
//
// Exit code is 1, and server.json is not written, when a field this script
// needs is missing or the version is not a valid semantic version.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A semantic version as semver.org 2.0.0 defines it: 1.2.3, with an optional
// pre-release or build part. No ranges and no "v" prefix: the registry wants
// one exact version. The three numbers and a numeric pre-release part have no
// leading zero (01.2.3 and 1.0.0-01 are not versions). No dot-separated part is
// empty (1.0.0-a..b and 1.0.0+.. are not versions).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Returns a copy of the parsed server.json with `version` set in both places:
 * the top level, and every packages[] entry with registryType "npm" whose
 * identifier is `npmPackageName`. Other entries and all other fields are kept
 * as they are. The object passed in is not changed.
 *
 * Throws when a field it must set is missing, so a manifest that this script
 * no longer understands stops the release instead of going out stale.
 */
export function syncServerJson(serverJson, version, npmPackageName) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`${JSON.stringify(version)} is not a valid version (expected a form like 1.2.3)`);
  }
  if (typeof npmPackageName !== "string" || npmPackageName === "") {
    throw new Error("the npm package name is missing");
  }
  if (serverJson === null || typeof serverJson !== "object" || Array.isArray(serverJson)) {
    throw new Error("server.json is not a JSON object");
  }
  if (typeof serverJson.version !== "string") {
    throw new Error('server.json has no top-level "version" field');
  }
  if (!Array.isArray(serverJson.packages)) {
    throw new Error('server.json has no "packages" array');
  }

  let matched = 0;
  const packages = serverJson.packages.map((entry, i) => {
    if (entry?.registryType !== "npm" || entry.identifier !== npmPackageName) return entry;
    if (typeof entry.version !== "string") {
      throw new Error(`server.json packages[${i}] (npm package "${npmPackageName}") has no "version" field`);
    }
    matched++;
    return { ...entry, version };
  });
  if (matched === 0) {
    throw new Error(
      `server.json has no packages[] entry with registryType "npm" and identifier "${npmPackageName}"`
    );
  }

  // Spreading keeps the key order, so no key moves in the file.
  return { ...serverJson, version, packages };
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`cannot read ${path.basename(file)} in ${path.dirname(file)} (${err.code ?? err.message})`);
  }
  try {
    return { text, data: JSON.parse(text) };
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid JSON (${err.message})`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    throw new Error("too many arguments. Usage: node scripts/sync-server-json.mjs [version]");
  }

  // npm runs lifecycle scripts in the package root, so the current directory is the repo root.
  const root = process.cwd();
  const pkg = readJson(path.join(root, "package.json")).data;
  if (typeof pkg.name !== "string" || pkg.name === "") {
    throw new Error('package.json has no "name" field');
  }
  if (args.length === 0 && typeof pkg.version !== "string") {
    throw new Error('package.json has no "version" field');
  }
  const version = args[0] ?? pkg.version;

  const serverPath = path.join(root, "server.json");
  const { text, data } = readJson(serverPath);
  const next = syncServerJson(data, version, pkg.name);

  if (JSON.stringify(next) === JSON.stringify(data)) {
    console.log(`sync-server-json: server.json is already at ${version}`);
    return;
  }

  // Write it back the way it was found: same indentation, same final newline.
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? 2;
  const finalNewline = text.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(serverPath, JSON.stringify(next, null, indent) + finalNewline);
  console.log(`sync-server-json: server.json ${data.version} -> ${version}`);
}

// Run only when executed directly, so tests can import syncServerJson.
// realpath on both sides: the ESM loader resolves symlinks, argv[1] does not.
function isMainModule() {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) {
  try {
    main();
  } catch (err) {
    console.error(`sync-server-json: ${err?.message ?? err}`);
    process.exit(1);
  }
}
