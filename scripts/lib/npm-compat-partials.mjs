import { correctnessRollup } from "./npm-compat-correctness.mjs";
import { mergeNpmPerfHistory, npmPerfHistoryPoint, npmPerfRows } from "./npm-compat-perf.mjs";
import { NPM_COMPAT_CATALOG_NAMES } from "../../tests/dogfood/npm-compat-catalog.mjs";

const CORE_PACKAGE_NAMES = ["acorn", "marked", "clsx", "cookie", "eslint", "prettier", "react"];

export const NPM_COMPAT_EXPECTED_PACKAGE_NAMES = Object.freeze(
  [...new Set([...CORE_PACKAGE_NAMES, ...NPM_COMPAT_CATALOG_NAMES])].sort(),
);

function sortPackages(packages) {
  return [...packages].sort(
    (left, right) =>
      (right.weeklyDownloads ?? Number.NEGATIVE_INFINITY) - (left.weeklyDownloads ?? Number.NEGATIVE_INFINITY) ||
      left.name.localeCompare(right.name),
  );
}

/**
 * Combine focused npm-compat worker reports into the same aggregate shape the
 * serial generator writes. Keeping this pure makes the matrix merge easy to
 * test without running a package compiler or upstream unit suite.
 */
export function mergeNpmCompatPartials(
  partials,
  {
    generatedAt = new Date().toISOString(),
    sourceRevision = null,
    existingHistory = { schemaVersion: 1, runs: [] },
    expectedNames = NPM_COMPAT_EXPECTED_PACKAGE_NAMES,
  } = {},
) {
  if (!Array.isArray(partials) || partials.length === 0) {
    throw new Error("npm-compat aggregation requires at least one partial report");
  }

  const packages = [];
  const seen = new Set();
  for (const partial of partials) {
    if (!partial || !Array.isArray(partial.packages) || partial.packages.length === 0) {
      throw new Error("npm-compat partial report has no package rows");
    }
    for (const packageRow of partial.packages) {
      if (!packageRow?.name) throw new Error("npm-compat partial report contains a nameless package row");
      if (seen.has(packageRow.name)) {
        throw new Error(`npm-compat partial reports duplicate package ${packageRow.name}`);
      }
      seen.add(packageRow.name);
      packages.push(packageRow);
    }
  }

  const expected = new Set(expectedNames);
  const missing = [...expected].filter((name) => !seen.has(name));
  const unexpected = [...seen].filter((name) => !expected.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `npm-compat partial package set mismatch; missing: ${missing.join(", ") || "(none)"}; ` +
        `unexpected: ${unexpected.join(", ") || "(none)"}`,
    );
  }

  const revisions = new Set(partials.map((partial) => partial.sourceRevision).filter(Boolean));
  if (sourceRevision && [...revisions].some((revision) => revision !== sourceRevision)) {
    throw new Error(
      `npm-compat partial source revision mismatch; expected ${sourceRevision}, received ${[...revisions].join(", ")}`,
    );
  }

  const firstMeta = partials.find((partial) => partial.summaryMeta)?.summaryMeta ?? {};
  const sortedPackages = sortPackages(packages);
  const summary = {
    generatedAt,
    correctness: correctnessRollup(sortedPackages),
    note: firstMeta.note ?? "Only packages with a committed, reproducible tests/dogfood harness are listed.",
    popularity: firstMeta.popularity ?? null,
    performanceMethodology: firstMeta.performanceMethodology ?? null,
    packages: sortedPackages,
  };
  const perfRows = npmPerfRows(sortedPackages);
  const perfHistory = mergeNpmPerfHistory(existingHistory, [
    npmPerfHistoryPoint(
      sortedPackages,
      generatedAt,
      sourceRevision,
      firstMeta.performanceMethodology?.optimizationLevels,
    ),
  ]);

  return { summary, perfRows, perfHistory };
}
