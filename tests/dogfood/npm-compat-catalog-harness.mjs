import { pathToFileURL } from "node:url";

import { createPackageEntryHarness } from "./package-entry-harness.mjs";
import {
  NPM_COMPAT_CATALOG_NAMES,
  npmCompatCatalogEntry,
  setupNpmCompatCatalogPackage,
} from "./npm-compat-catalog.mjs";

export function createNpmCompatCatalogHarness(name) {
  const entry = npmCompatCatalogEntry(name);
  return createPackageEntryHarness({
    name,
    issue: entry.issue ?? null,
    setup: () => setupNpmCompatCatalogPackage(name),
    timeoutMs: entry.timeoutMs ?? 120_000,
    compileOptions: {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
      ...(entry.compileOptions ?? {}),
    },
  });
}

export function runNpmCompatCatalogHarness(name, options) {
  return createNpmCompatCatalogHarness(name)(options);
}

function optionValue(name) {
  const exact = process.argv.indexOf(name);
  return exact < 0 ? null : process.argv[exact + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const name = optionValue("--package");
  if (!name) {
    throw new Error(`--package expects one of ${NPM_COMPAT_CATALOG_NAMES.join(", ")}`);
  }
  const jsonOnly = process.argv.includes("--json");
  runNpmCompatCatalogHarness(name, { quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
    })
    .catch((error) => {
      if (jsonOnly) {
        process.stdout.write(`${JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) })}\n`);
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    });
}
