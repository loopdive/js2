import { correctnessRollup } from "./npm-compat-correctness.mjs";
import { esEditionRollup } from "./npm-compat-es-edition.mjs";
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
    existingPackages = [],
    existingSummaryMeta = null,
    existingGeneratedAt = null,
    staleReason = "measurement worker did not produce a partial report",
    allowStaleFallback = false,
    expectedNames = NPM_COMPAT_EXPECTED_PACKAGE_NAMES,
  } = {},
) {
  if (!Array.isArray(partials)) {
    throw new Error("npm-compat aggregation requires an array of partial reports");
  }
  if (
    partials.length === 0 &&
    (!allowStaleFallback || !Array.isArray(existingPackages) || existingPackages.length === 0)
  ) {
    throw new Error("npm-compat aggregation requires at least one partial report or an existing snapshot");
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
  const existingByName = new Map(
    (Array.isArray(existingPackages) ? existingPackages : [])
      .filter((packageRow) => packageRow?.name)
      .map((packageRow) => [packageRow.name, packageRow]),
  );
  const stalePackages = [];
  for (const name of allowStaleFallback ? [...expected].filter((candidate) => !seen.has(candidate)) : []) {
    const previous = existingByName.get(name);
    // A carried-forward row keeps ITS OWN measurement time. Deriving it from
    // the previous SNAPSHOT's `generatedAt` (what this did until 2026-08-23)
    // makes the reported date creep forward one refresh at a time: a package
    // stale across five promotions would claim it was measured at the fifth,
    // having actually run before the first. With the fast lane promoting every
    // ~12 minutes and react-dom's row taking 3-4 hours, that drift is the
    // normal case, not an edge one.
    //
    // For rows written before `measuredAt` existed, migrate from the truth the
    // old shape DID carry: a row already marked stale records its real date in
    // `refresh.lastMeasuredAt`. Reaching past that to `existingGeneratedAt`
    // would commit the creep once, permanently — against the live 2026-08-23
    // artifact it restamped react-dom from its true 08-20 18:44 to the 15:27
    // snapshot, and no later run could recover the real date. The snapshot
    // time is right only for a row that has never been stale, which is exactly
    // the case where neither of the first two is present.
    const previouslyMeasuredAt =
      previous?.measuredAt ?? previous?.refresh?.lastMeasuredAt ?? existingGeneratedAt ?? null;
    const packageRow = previous
      ? {
          ...previous,
          ...(previouslyMeasuredAt ? { measuredAt: previouslyMeasuredAt } : {}),
          refresh: {
            status: "stale",
            reason: staleReason,
            ...(previouslyMeasuredAt ? { lastMeasuredAt: previouslyMeasuredAt } : {}),
          },
        }
      : {
          name,
          version: null,
          issue: null,
          entryFile: null,
          shape: null,
          compile: { success: false, error: staleReason },
          validation: { validates: false, firstError: staleReason },
          tests: { kind: "upstream-suite", status: "refresh-failed", reason: staleReason },
          correctness: { status: "unverified", reason: staleReason },
          perf: null,
          knownBugs: [],
          refresh: { status: "stale", reason: staleReason },
        };
    packages.push(packageRow);
    seen.add(name);
    stalePackages.push(name);
  }
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

  const firstMeta = partials.find((partial) => partial.summaryMeta)?.summaryMeta ?? existingSummaryMeta ?? {};
  // A fresh row written by a generator that predates per-package stamping gets
  // this assembly's time: it really was measured in this run.
  const sortedPackages = sortPackages(packages).map((packageRow) =>
    packageRow.measuredAt ? packageRow : { ...packageRow, measuredAt: generatedAt },
  );
  const freshPackages = sortedPackages.filter((packageRow) => packageRow.refresh?.status !== "stale");
  const measuredAtStamps = sortedPackages.map((packageRow) => packageRow.measuredAt).filter(Boolean);
  const summary = {
    generatedAt,
    // The SPREAD of measurement times across the corpus. The page headline is
    // built from this, not from `generatedAt`: with per-package rows the two
    // ends can be days apart, and one timestamp over a mixed-age corpus
    // presents the oldest numbers as if they were current.
    measuredRange:
      measuredAtStamps.length > 0
        ? {
            oldest: measuredAtStamps.reduce((left, right) => (left < right ? left : right)),
            newest: measuredAtStamps.reduce((left, right) => (left > right ? left : right)),
          }
        : null,
    correctness: correctnessRollup(sortedPackages),
    // Rebuilt here, not copied from a partial: the sharded path assembles the
    // shipped artifact from worker reports and constructs this summary itself,
    // so a rollup added only to the single-process generator would be present
    // locally and absent from every artifact CI actually publishes. The rows
    // carry `esEdition`, so the corpus-level view is derivable from them.
    esEditions: esEditionRollup(sortedPackages),
    note: firstMeta.note ?? "Only packages with a committed, reproducible tests/dogfood harness are listed.",
    popularity: firstMeta.popularity ?? null,
    performanceMethodology: firstMeta.performanceMethodology ?? null,
    refresh: {
      status: stalePackages.length > 0 ? "partial" : "complete",
      stalePackages: [...stalePackages].sort(),
      freshCount: freshPackages.length,
      totalCount: sortedPackages.length,
    },
    packages: sortedPackages,
  };
  // The perf ARTIFACT is built from the WHOLE corpus, not only what this run
  // re-measured. A carried-forward row keeps its own last measurement in
  // `packages[]` and the card still renders it, stamped with its real
  // `measuredAt` — so dropping it from the perf chart makes the chart disagree
  // with the cards beside it. Since the per-package split that stopped being a
  // cosmetic inconsistency and became a hard stop: a promotion routinely
  // carries ONE fresh package (react-dom's lane runs on its own 3-4h cadence
  // and promotes alone), and on 2026-08-24T02:31Z it did exactly that with all
  // three of react-dom's lanes at `compile-error`. Fresh-only rows made
  // `npm-compat-perf.json` come out `[]`, which
  // `check-npm-compat-promotion.mjs` rejects — "must contain performance
  // measurements" — failing `quality` and stranding the promotion PR.
  //
  // The HISTORY point stays fresh-only, deliberately: it is a time series, and
  // appending a carried-forward measurement under this run's `generatedAt`
  // would claim a measurement happened now that did not.
  const perfRows = npmPerfRows(sortedPackages);
  const perfHistory = mergeNpmPerfHistory(
    existingHistory,
    freshPackages.length > 0
      ? [
          npmPerfHistoryPoint(
            freshPackages,
            generatedAt,
            sourceRevision,
            firstMeta.performanceMethodology?.optimizationLevels,
          ),
        ]
      : [],
  );

  return { summary, perfRows, perfHistory };
}
