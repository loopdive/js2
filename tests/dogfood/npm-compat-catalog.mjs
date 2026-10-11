import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/**
 * Give the extracted packages pnpm's hoisted-dependency fallback.
 *
 * `setupPinnedPackage` links `.npm-compat/<name>/node_modules` to the
 * package's pnpm importer directory (`.pnpm/<pkg>@<v>/node_modules`), which
 * holds only its DECLARED dependencies. The installed copy resolves one level
 * further: Node walks from the importer directory up to `.pnpm/node_modules`,
 * pnpm's hidden hoist directory, where transitive packages live. Packages that
 * `require` an undeclared (transitive) dependency depend on that fallback —
 * jest 30's `build/index.js` requires `jest-config`, which is not in its
 * `dependencies` — so the extracted copy failed to import natively in CI
 * ("Cannot find module 'jest-config'") while the installed copy works.
 *
 * `.npm-compat/node_modules` is exactly the next directory Node probes after
 * `.npm-compat/<name>/node_modules`, so linking it to the hoist directory
 * restores the installed package's resolution order without touching the
 * package contents. A flat (npm) tree has no `.pnpm` store and is left as is.
 */
function wirePnpmHoistFallback(importerNodeModules) {
  if (!importerNodeModules) return null;
  let store;
  try {
    store = dirname(dirname(realpathSync(importerNodeModules)));
  } catch {
    return null;
  }
  const hoisted = join(store, "node_modules");
  if (basename(store) !== ".pnpm" || !existsSync(hoisted)) return null;
  const link = join(HERE, ".npm-compat", "node_modules");
  let stat = null;
  try {
    stat = lstatSync(link);
  } catch {
    // No link yet; create it below.
  }
  if (stat) {
    // Never replace a real directory — only a link this helper created.
    if (!stat.isSymbolicLink()) return null;
    try {
      if (realpathSync(link) === realpathSync(hoisted)) return link;
    } catch {
      // Dangling link from an older install; replaced below.
    }
    rmSync(link, { force: true });
  }
  symlinkSync(hoisted, link, "dir");
  return link;
}

export function setupNpmCompatCatalogPackage(name, options = {}) {
  const pin = npmCompatCatalogEntry(name);
  const setup = setupPinnedPackage({
    here: HERE,
    name,
    pin,
    extractionDirectory: `.npm-compat/${name}`,
    force: options.force,
    allowMissingEntry: pin.expectedEntryMissing === true,
  });
  return { ...setup, hoistedNodeModulesPath: wirePnpmHoistFallback(setup.dependencyNodeModulesPath) };
}
