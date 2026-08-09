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
