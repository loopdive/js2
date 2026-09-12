// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5368 — enumerate the modules a dogfood package actually presents to the
// compiler, not just its declared entry.
//
// WHY. `scripts/check-dogfood-validation.mjs` (#5336) asserts
// `compile.success ⇒ the emitted binary validates`, but it only ever compiled
// `<pkg>/<declared entry>`. A module the dogfood SUITES admit through a
// subpath was never compiled by the gate, so #5339 — hono's
// `dist/helper/dev/index.js`, whose `utils/color.js` dependency emitted
// `getColorEnabledAsync` with `type error in return[0] (expected i32, got
// externref)` — was live on main with the gate green. It surfaced only as a
// whole-file `0/8` in the hono upstream suite.
//
// THE TWO SURFACES.
//
//   "suite"    the modules the dogfood upstream suites admit. This is the
//              gated surface: it is what the suites already compile, so a
//              module in it that does not validate is a bug the project has
//              already committed to caring about.
//
//   "exports"  every distinct file the package's `exports` map resolves to.
//              A strictly wider survey surface, NOT gated — see the
//              `--surface exports` note in the gate script. Enumerating it is
//              cheap; compiling it is not, and on main today it is not clean.
//
// SUITE ENUMERATION, AND WHY IT IS DECLARATIVE. The suites do not share one
// src→dist convention. Most of them (redux, jest, styled-components, moment,
// react) compile the UPSTREAM REPOSITORY's sources against the package, so the
// only published module they admit is the declared entry. hono is the
// exception: `tests/dogfood/hono-upstream-suite.mjs` rewrites each selected
// test's relative imports onto the published `dist/` tree, so every selected
// `src/<rest>.test.ts` admits `dist/<rest>.js` (or `dist/<rest>/index.js`).
// That mapping is stated here as DATA keyed by package, derived from the
// committed suite pin — so the gate needs no upstream clone and no generated
// tree, and adding a package is one table entry rather than new logic.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { npmCompatCatalogEntry, setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Packages whose upstream suite admits published subpath modules, and how its
 * selected test paths map onto them. `pin` is the committed suite pin, so this
 * enumeration is reproducible from the repository alone.
 */
const SUITE_SUBPATH_MAPS = {
  hono: {
    pin: "hono-upstream-suite-pin.json",
    sourcePrefix: "src/",
    distPrefix: "dist/",
    note: "hono-upstream-suite.mjs rewrites each selected test's relative imports onto package/dist",
  },
};

/** Conditions to resolve an `exports` entry with, most specific first. */
const EXPORT_CONDITIONS = ["import", "module", "default", "node", "require"];

function resolveCondition(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  for (const condition of EXPORT_CONDITIONS) {
    if (!(condition in value)) continue;
    const resolved = resolveCondition(value[condition]);
    if (resolved) return resolved;
  }
  return null;
}

function normalize(relativePath) {
  return relativePath.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Modules the package's `exports` map resolves to, as package-root-relative paths. */
function exportsMapModules(packageRoot, manifest) {
  const map = manifest.exports;
  if (!map || typeof map !== "object") return [];
  const found = new Set();
  for (const [subpath, value] of Object.entries(map)) {
    // A `*` pattern needs a directory walk to expand and a `.json` subpath is
    // not a module; neither belongs in a compile surface.
    if (subpath.includes("*") || subpath.endsWith(".json")) continue;
    const target = resolveCondition(value);
    if (!target || !/\.(?:js|mjs|cjs)$/.test(target)) continue;
    const normalized = normalize(target);
    if (existsSync(join(packageRoot, normalized))) found.add(normalized);
  }
  return [...found];
}

/** Published modules the package's upstream dogfood suite admits. */
function suiteSubpathModules(name, packageRoot) {
  const map = SUITE_SUBPATH_MAPS[name];
  if (!map) return [];
  let pin;
  try {
    pin = JSON.parse(readFileSync(join(HERE, map.pin), "utf-8"));
  } catch {
    return [];
  }
  const found = new Set();
  for (const testPath of pin.selectedFiles ?? []) {
    if (!testPath.startsWith(map.sourcePrefix)) continue;
    const rest = testPath.slice(map.sourcePrefix.length).replace(/\.test\.tsx?$/, "");
    if (rest === testPath) continue;
    for (const candidate of [`${map.distPrefix}${rest}.js`, `${map.distPrefix}${rest}/index.js`]) {
      if (!existsSync(join(packageRoot, candidate))) continue;
      found.add(candidate);
      break;
    }
  }
  return [...found];
}

/**
 * Enumerate the compile surface of one npm-compat catalog package.
 *
 * @param {string} name catalog package name
 * @param {{ surface?: "suite" | "exports" }} options
 * @returns {{ name: string, version: string, packageRoot: string, entryModule: string,
 *            modules: Array<{ path: string, origin: "entry" | "suite" | "exports" }> }}
 */
export function dogfoodSurfaceModules(name, { surface = "suite" } = {}) {
  const pin = npmCompatCatalogEntry(name);
  const setup = setupNpmCompatCatalogPackage(name);
  // Every catalog pin's `entryModule` is `package/<something>`; the tarball's
  // own root is that first segment, and every path below is relative to it.
  const packageRootName = pin.entryModule.split("/")[0];
  const packageRoot = join(setup.root, packageRootName);
  const entryModule = pin.entryModule.slice(packageRootName.length + 1);

  const origins = new Map();
  const add = (path, origin) => {
    if (!origins.has(path)) origins.set(path, origin);
  };
  if (setup.entryExists) add(entryModule, "entry");

  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
  } catch {
    // A tarball without a readable manifest still has its declared entry; the
    // wider surfaces simply contribute nothing.
  }

  for (const path of suiteSubpathModules(name, packageRoot)) add(path, "suite");
  if (surface === "exports") {
    for (const path of exportsMapModules(packageRoot, manifest)) add(path, "exports");
  }

  return {
    name,
    version: setup.version,
    packageRoot,
    entryModule,
    // Sorted so the gate's output and its failure ordering are deterministic.
    modules: [...origins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, origin]) => ({ path, origin })),
  };
}

export const DOGFOOD_SURFACES = Object.freeze(["suite", "exports"]);
export const DOGFOOD_SUITE_SUBPATH_PACKAGES = Object.freeze(Object.keys(SUITE_SUBPATH_MAPS));
