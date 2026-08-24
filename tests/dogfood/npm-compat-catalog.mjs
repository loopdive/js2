import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedPackage } from "./setup-pinned-package.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(new URL("./npm-compat-catalog.json", import.meta.url), "utf-8"));
const byName = new Map(catalog.map((entry) => [entry.name, Object.freeze(entry)]));

if (byName.size !== catalog.length) {
  throw new Error("[dogfood] npm compatibility catalog contains duplicate package names");
}

export const NPM_COMPAT_CATALOG = Object.freeze([...byName.values()]);
export const NPM_COMPAT_CATALOG_NAMES = Object.freeze(NPM_COMPAT_CATALOG.map((entry) => entry.name));

// Packages measured by npm-compat that predate the pinned catalog (no tarball
// pin entry; the generator wires them directly). Kept HERE so the generator
// and the CI matrix planner (scripts/list-npm-compat-packages.mjs) share one
// enumeration — adding a package to either list auto-scales the
// npm-compat-refresh workflow with no YAML edit.
export const NPM_COMPAT_LEGACY_PACKAGE_NAMES = Object.freeze([
  "acorn",
  "marked",
  "clsx",
  "cookie",
  "eslint",
  "prettier",
  "react",
]);

export const NPM_COMPAT_ALL_PACKAGE_NAMES = Object.freeze([
  ...new Set([...NPM_COMPAT_LEGACY_PACKAGE_NAMES, ...NPM_COMPAT_CATALOG_NAMES]),
]);

// Long-pole packages (they run their own upstream suites for hours) — the
// refresh workflow gives these their own measure/promotion lane so the fast
// lane's dashboard update never waits on them. Membership is data on the
// catalog entry (`"longPole": true`), not workflow YAML.
export const NPM_COMPAT_LONG_POLE_NAMES = Object.freeze(
  NPM_COMPAT_CATALOG.filter((entry) => entry.longPole === true).map((entry) => entry.name),
);

export function npmCompatCatalogEntry(name) {
  const entry = byName.get(name);
  if (!entry) {
    throw new Error(
      `[dogfood] unknown npm compatibility catalog package ${name}; expected one of ${NPM_COMPAT_CATALOG_NAMES.join(", ")}`,
    );
  }
  return entry;
}

export function setupNpmCompatCatalogPackage(name, options = {}) {
  const pin = npmCompatCatalogEntry(name);
  return setupPinnedPackage({
    here: HERE,
    name,
    pin,
    extractionDirectory: `.npm-compat/${name}`,
    force: options.force,
    allowMissingEntry: pin.expectedEntryMissing === true,
  });
}
