#!/usr/bin/env node
/**
 * Validate the evidence produced by a Test262 shard run.
 *
 * A Vitest failure is not, by itself, evidence that a shard is incomplete:
 * conformance failures deliberately make Vitest exit non-zero.  Conversely,
 * a shard can reach afterAll after Vitest has abandoned one or more callbacks.
 * This validator therefore treats the per-shard completion manifests and the
 * JSONL identity set as the source of truth for whether a report is publishable.
 *
 * The validator is intentionally independent of Vitest and the compiler.  It
 * can be used by the local runner, CI merge jobs, and focused unit tests without
 * starting a compiler worker.
 */

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TEST262_COMPLETION_MANIFEST_SCHEMA = "test262-shard-completion-v2";
export const TEST262_VERDICT_STATUSES = new Set(["pass", "fail", "compile_error", "compile_timeout", "skip"]);

/** Return the durable completion filename for one logical shard. */
export function getTest262ShardCompletionPath(jsonlPath, chunkIndex, chunkTotal) {
  const basename = String(jsonlPath).endsWith(".jsonl") ? String(jsonlPath).slice(0, -".jsonl".length) : jsonlPath;
  return `${basename}.shard-${chunkIndex + 1}-of-${chunkTotal}.complete.json`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validIdentityPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("..")
  );
}

function addError(errors, code, message, details = {}) {
  errors.push({ code, message, ...details });
}

/**
 * Parse a JSONL verdict stream while preserving physical line numbers.
 *
 * Blank lines are ignored so an editor-added trailing newline is harmless;
 * every other line must be a JSON object with the three identity fields used by
 * the report builder.
 */
export function parseTest262Jsonl(text) {
  const errors = [];
  const rows = [];
  const identityRows = new Map();
  const lines = String(text ?? "").split(/\r?\n/);
  let physicalRows = 0;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (raw.trim() === "") continue;
    physicalRows++;
    const line = index + 1;
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      addError(errors, "malformed-jsonl", `JSONL line ${line} is not valid JSON: ${error?.message ?? error}`, {
        line,
      });
      continue;
    }

    if (!isObject(record)) {
      addError(errors, "malformed-row", `JSONL line ${line} must contain an object`, { line });
      continue;
    }

    const file = record.file;
    const category = record.category;
    const status = record.status;
    if (!validIdentityPath(file)) {
      addError(errors, "malformed-row-identity", `JSONL line ${line} has an invalid file identity`, { line });
      continue;
    }
    if (typeof category !== "string" || category.length === 0) {
      addError(errors, "malformed-row-category", `JSONL line ${line} has no category`, { line, file });
      continue;
    }
    if (typeof status !== "string" || !TEST262_VERDICT_STATUSES.has(status)) {
      addError(errors, "malformed-row-status", `JSONL line ${line} has an unknown status ${JSON.stringify(status)}`, {
        line,
        file,
      });
      continue;
    }

    const previous = identityRows.get(file);
    if (previous) {
      addError(
        errors,
        "duplicate-verdict-identity",
        `JSONL identity ${file} occurs on lines ${previous.line} and ${line} (${previous.status}, ${status})`,
        {
          file,
          lines: [previous.line, line],
          statuses: [previous.status, status],
        },
      );
    } else {
      identityRows.set(file, { line, status });
    }
    rows.push({ record, line, identity: file });
  }

  return {
    errors,
    rows,
    identities: new Set(identityRows.keys()),
    identityRows,
    physicalRows,
  };
}

function exclusionBucket(manifest, name, errors, manifestLabel) {
  const exclusions = isObject(manifest.exclusions) ? manifest.exclusions : {};
  const raw = exclusions[name];
  if (raw === undefined) {
    addError(errors, "manifest-missing-exclusions", `${manifestLabel} is missing exclusions.${name}`);
    return { count: 0, paths: [] };
  }

  // Arrays are accepted as a small convenience for hand-authored fixtures;
  // production manifests use { count, paths } so the count is explicit.
  if (Array.isArray(raw)) {
    return { count: raw.length, paths: raw };
  }
  if (typeof raw === "number") {
    if (!isNonNegativeInteger(raw)) {
      addError(errors, "manifest-malformed-exclusions", `${manifestLabel} exclusions.${name}.count is not an integer`);
      return { count: 0, paths: [] };
    }
    addError(errors, "manifest-missing-exclusion-paths", `${manifestLabel} exclusions.${name} has no paths`);
    return { count: raw, paths: [] };
  }
  if (!isObject(raw)) {
    addError(errors, "manifest-malformed-exclusions", `${manifestLabel} exclusions.${name} must be an object`);
    return { count: 0, paths: [] };
  }

  const count = raw.count;
  const paths = raw.paths;
  if (!isNonNegativeInteger(count)) {
    addError(errors, "manifest-malformed-exclusions", `${manifestLabel} exclusions.${name}.count is not an integer`);
  }
  if (!Array.isArray(paths)) {
    addError(errors, "manifest-missing-exclusion-paths", `${manifestLabel} exclusions.${name}.paths is not an array`);
  }
  const safeCount = isNonNegativeInteger(count) ? count : 0;
  const safePaths = Array.isArray(paths) ? paths : [];
  if (safeCount !== safePaths.length) {
    addError(
      errors,
      "manifest-exclusion-count-mismatch",
      `${manifestLabel} exclusions.${name} declares ${safeCount} paths but contains ${safePaths.length}`,
    );
  }
  return { count: safeCount, paths: safePaths };
}

function validateManifest(manifest, index, errors) {
  const manifestLabel = `shard manifest ${manifest?.path ?? `#${index + 1}`}`;
  if (!isObject(manifest)) {
    addError(errors, "malformed-shard-manifest", `${manifestLabel} must contain an object`, {
      manifest: manifestLabel,
    });
    return null;
  }

  if (manifest.schema !== TEST262_COMPLETION_MANIFEST_SCHEMA) {
    addError(
      errors,
      "manifest-schema-mismatch",
      `${manifestLabel} has schema ${JSON.stringify(manifest.schema)}, expected ${TEST262_COMPLETION_MANIFEST_SCHEMA}`,
      { manifest: manifestLabel },
    );
  }
  if (typeof manifest.runTimestamp !== "string" || manifest.runTimestamp.length === 0) {
    addError(errors, "manifest-malformed-run-timestamp", `${manifestLabel} runTimestamp is missing`);
  }
  if (!Number.isInteger(manifest.chunkIndex) || manifest.chunkIndex < 0) {
    addError(errors, "manifest-malformed-chunk", `${manifestLabel} chunkIndex is not a non-negative integer`);
  }
  if (!isPositiveInteger(manifest.chunkTotal)) {
    addError(errors, "manifest-malformed-chunk", `${manifestLabel} chunkTotal is not a positive integer`);
  } else if (
    Number.isInteger(manifest.chunkIndex) &&
    (manifest.chunkIndex < 0 || manifest.chunkIndex >= manifest.chunkTotal)
  ) {
    addError(
      errors,
      "manifest-malformed-chunk",
      `${manifestLabel} chunkIndex ${manifest.chunkIndex} is outside chunkTotal ${manifest.chunkTotal}`,
    );
  }
  if (typeof manifest.target !== "string" || manifest.target.length === 0) {
    addError(errors, "manifest-malformed-target", `${manifestLabel} target is missing`);
  }

  const registeredPaths = manifest.registeredPaths;
  if (!Array.isArray(registeredPaths)) {
    addError(errors, "manifest-missing-registered-paths", `${manifestLabel} registeredPaths is not an array`);
  }
  const safeRegisteredPaths = Array.isArray(registeredPaths) ? registeredPaths : [];
  const registeredSet = new Set();
  for (const path of safeRegisteredPaths) {
    if (!validIdentityPath(path)) {
      addError(errors, "manifest-malformed-registered-path", `${manifestLabel} contains an invalid registered path`, {
        manifest: manifestLabel,
        file: path,
      });
      continue;
    }
    if (registeredSet.has(path)) {
      addError(errors, "manifest-duplicate-registered-path", `${manifestLabel} registers ${path} more than once`, {
        manifest: manifestLabel,
        file: path,
      });
    }
    registeredSet.add(path);
  }

  const registeredTests = manifest.registeredTests;
  if (!isNonNegativeInteger(registeredTests)) {
    addError(errors, "manifest-malformed-count", `${manifestLabel} registeredTests is not a non-negative integer`);
  } else if (registeredTests !== safeRegisteredPaths.length) {
    addError(
      errors,
      "manifest-registered-count-mismatch",
      `${manifestLabel} declares ${registeredTests} registered tests but lists ${safeRegisteredPaths.length}`,
      { manifest: manifestLabel },
    );
  }

  const canonicalVerdicts = manifest.canonicalVerdicts ?? manifest.recordedRows;
  if (!isNonNegativeInteger(canonicalVerdicts)) {
    addError(
      errors,
      "manifest-malformed-count",
      `${manifestLabel} canonical verdict count is not a non-negative integer`,
    );
  }
  if (manifest.canonicalVerdicts !== undefined && manifest.recordedRows !== undefined) {
    if (manifest.canonicalVerdicts !== manifest.recordedRows) {
      addError(
        errors,
        "manifest-verdict-count-alias-mismatch",
        `${manifestLabel} canonicalVerdicts and recordedRows disagree (${manifest.canonicalVerdicts} vs ${manifest.recordedRows})`,
      );
    }
  }

  const proposal = exclusionBucket(manifest, "proposal", errors, manifestLabel);
  const official = exclusionBucket(manifest, "official", errors, manifestLabel);
  const exclusionPaths = new Set();
  for (const [kind, bucket] of [
    ["proposal", proposal],
    ["official", official],
  ]) {
    for (const path of bucket.paths) {
      if (!validIdentityPath(path)) {
        addError(
          errors,
          "manifest-malformed-exclusion-path",
          `${manifestLabel} has an invalid ${kind} exclusion path`,
          {
            manifest: manifestLabel,
            file: path,
          },
        );
        continue;
      }
      if (!registeredSet.has(path)) {
        addError(
          errors,
          "manifest-exclusion-not-registered",
          `${manifestLabel} excludes ${path}, but that path is not registered`,
          { manifest: manifestLabel, file: path },
        );
      }
      if (exclusionPaths.has(path)) {
        addError(errors, "manifest-duplicate-exclusion", `${manifestLabel} excludes ${path} more than once`, {
          manifest: manifestLabel,
          file: path,
        });
      }
      exclusionPaths.add(path);
    }
  }

  const exclusionCount = proposal.count + official.count;
  if (isNonNegativeInteger(registeredTests) && isNonNegativeInteger(canonicalVerdicts)) {
    if (registeredTests !== canonicalVerdicts + exclusionCount) {
      addError(
        errors,
        "manifest-verdict-count-mismatch",
        `${manifestLabel}: registered ${registeredTests} != canonical verdicts ${canonicalVerdicts} + explicit exclusions ${exclusionCount}`,
        { manifest: manifestLabel },
      );
    }
  }

  const callbacksStarted = manifest.callbacksStarted;
  const callbacksSettled = manifest.callbacksSettled;
  if (!isNonNegativeInteger(callbacksStarted) || !isNonNegativeInteger(callbacksSettled)) {
    addError(
      errors,
      "manifest-malformed-callback-count",
      `${manifestLabel} callback counts are not non-negative integers`,
    );
  }
  if (manifest.allCallbacksSettled !== true) {
    addError(errors, "callbacks-unsettled", `${manifestLabel} does not prove that all callbacks settled`);
  }
  if (isNonNegativeInteger(registeredTests) && callbacksStarted !== registeredTests) {
    addError(
      errors,
      "manifest-callback-start-count-mismatch",
      `${manifestLabel}: callbacksStarted ${callbacksStarted} != registered ${registeredTests}`,
    );
  }
  if (isNonNegativeInteger(registeredTests) && callbacksSettled !== registeredTests) {
    addError(
      errors,
      "manifest-callback-settlement-count-mismatch",
      `${manifestLabel}: callbacksSettled ${callbacksSettled} != registered ${registeredTests}`,
    );
  }

  return {
    manifest,
    label: manifestLabel,
    chunkIndex: manifest.chunkIndex,
    chunkTotal: manifest.chunkTotal,
    target: manifest.target,
    registeredTests: isNonNegativeInteger(registeredTests) ? registeredTests : 0,
    canonicalVerdicts: isNonNegativeInteger(canonicalVerdicts) ? canonicalVerdicts : 0,
    exclusionCount,
    registeredPaths: safeRegisteredPaths,
    registeredSet,
    exclusionPaths,
  };
}

/**
 * Validate a JSONL stream against durable per-shard completion manifests.
 *
 * `jsonlText` is the complete stream being considered. `manifests` may contain
 * parsed objects or `{ manifest, path }` wrappers (the CLI uses the latter so
 * diagnostics name the source file). `expectedShardCount` is optional because
 * a deliberately narrowed local shard glob is valid; when supplied it is the
 * number of shard files requested by that invocation, not necessarily the
 * manifest's baked-in full-corpus chunkTotal.
 */
export function evaluateTest262Completeness(jsonlText, manifests, options = {}) {
  const errors = [];
  const parsedRows = parseTest262Jsonl(jsonlText);
  errors.push(...parsedRows.errors);

  const inputManifests = Array.isArray(manifests) ? manifests : [];
  if (inputManifests.length === 0) {
    addError(errors, "missing-shard-manifest", "No Test262 shard completion manifests were provided");
  }

  const shardRecords = [];
  const chunkIndices = new Set();
  const registeredPaths = new Set();
  const expectedVerdictPaths = new Set();
  let registeredTests = 0;
  let canonicalVerdicts = 0;
  let explicitExclusions = 0;
  let chunkTotal;
  let target;

  for (let index = 0; index < inputManifests.length; index++) {
    const input = inputManifests[index];
    const wrapper = isObject(input) && isObject(input.manifest) ? input : { manifest: input };
    const manifest =
      wrapper.path && isObject(wrapper.manifest) ? { ...wrapper.manifest, path: wrapper.path } : wrapper.manifest;
    const record = validateManifest(manifest, index, errors);
    if (!record) continue;
    shardRecords.push(record);

    if (chunkIndices.has(record.chunkIndex)) {
      addError(errors, "duplicate-shard-index", `${record.label} repeats chunkIndex ${record.chunkIndex}`);
    }
    chunkIndices.add(record.chunkIndex);
    if (chunkTotal === undefined) chunkTotal = record.chunkTotal;
    else if (chunkTotal !== record.chunkTotal) {
      addError(
        errors,
        "shard-total-mismatch",
        `${record.label} has chunkTotal ${record.chunkTotal}, expected ${chunkTotal}`,
      );
    }
    if (target === undefined) target = record.target;
    else if (target !== record.target)
      addError(errors, "shard-target-mismatch", `${record.label} target differs from other shards`);

    registeredTests += record.registeredTests;
    canonicalVerdicts += record.canonicalVerdicts;
    explicitExclusions += record.exclusionCount;

    for (const path of record.registeredPaths) {
      if (registeredPaths.has(path)) {
        addError(errors, "duplicate-registered-identity", `Path ${path} is registered by more than one shard`, {
          file: path,
        });
      }
      registeredPaths.add(path);
      if (!record.exclusionPaths.has(path)) expectedVerdictPaths.add(path);
    }
  }

  if (options.expectedShardCount !== undefined) {
    if (!isNonNegativeInteger(options.expectedShardCount)) {
      addError(errors, "invalid-expected-shard-count", "expectedShardCount must be a non-negative integer");
    } else if (shardRecords.length !== options.expectedShardCount) {
      addError(
        errors,
        "missing-shard-manifest",
        `Expected ${options.expectedShardCount} shard manifests but found ${shardRecords.length}`,
        { expected: options.expectedShardCount, actual: shardRecords.length },
      );
    }
  }

  const expectedPathsOption = options.expectedPaths;
  if (expectedPathsOption !== undefined) {
    if (!Array.isArray(expectedPathsOption)) {
      addError(errors, "invalid-expected-paths", "expectedPaths must be an array");
    } else {
      const exactExpected = new Set();
      for (const path of expectedPathsOption) {
        if (exactExpected.has(path)) {
          addError(errors, "duplicate-expected-path", `Expected path occurs more than once: ${path}`);
        }
        exactExpected.add(path);
        if (!validIdentityPath(path)) addError(errors, "invalid-expected-path", `Expected path is invalid: ${path}`);
      }
      // The exact filter file describes the callbacks the runner was asked to
      // register, including callbacks later accounted for as explicit
      // proposal/official exclusions. Verdict identity completeness below
      // still compares rows only with the non-excluded subset.
      if (
        exactExpected.size !== registeredPaths.size ||
        [...exactExpected].some((path) => !registeredPaths.has(path))
      ) {
        addError(
          errors,
          "manifest-scope-mismatch",
          `Manifest selected identity set does not match the exact expected scope (manifest ${registeredPaths.size}, expected ${exactExpected.size})`,
        );
      }
    }
  }

  const rowIdentities = parsedRows.identities;
  const missing = [...expectedVerdictPaths].filter((path) => !rowIdentities.has(path)).sort();
  const unexpected = [...rowIdentities].filter((path) => !expectedVerdictPaths.has(path)).sort();
  if (missing.length > 0) {
    addError(
      errors,
      "missing-verdict-identity",
      `Missing ${missing.length} canonical verdict identities: ${missing.join(", ")}`,
      {
        missing,
      },
    );
  }
  if (unexpected.length > 0) {
    addError(
      errors,
      "unexpected-verdict-identity",
      `Found ${unexpected.length} verdict identities outside the selected scope: ${unexpected.join(", ")}`,
      {
        unexpected,
      },
    );
  }

  if (canonicalVerdicts !== parsedRows.physicalRows) {
    addError(
      errors,
      "manifest-jsonl-row-count-mismatch",
      `Manifest canonical verdict total ${canonicalVerdicts} != JSONL physical row total ${parsedRows.physicalRows}`,
      { manifest: canonicalVerdicts, jsonl: parsedRows.physicalRows },
    );
  }
  if (canonicalVerdicts !== rowIdentities.size) {
    addError(
      errors,
      "manifest-jsonl-unique-count-mismatch",
      `Manifest canonical verdict total ${canonicalVerdicts} != JSONL unique identity total ${rowIdentities.size}`,
      { manifest: canonicalVerdicts, jsonl: rowIdentities.size },
    );
  }
  if (registeredTests !== canonicalVerdicts + explicitExclusions) {
    addError(
      errors,
      "aggregate-verdict-count-mismatch",
      `Aggregate registered ${registeredTests} != canonical verdicts ${canonicalVerdicts} + explicit exclusions ${explicitExclusions}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      shards: shardRecords.length,
      chunkTotal: chunkTotal ?? null,
      target: target ?? null,
      registeredTests,
      canonicalVerdicts,
      explicitExclusions,
      physicalRows: parsedRows.physicalRows,
      uniqueRows: rowIdentities.size,
      missing,
      unexpected,
      duplicateIdentities: parsedRows.errors.filter((error) => error.code === "duplicate-verdict-identity").length,
    },
    rows: parsedRows.rows,
    manifests: shardRecords,
  };
}

// Friendly alias for callers that prefer the imperative name.
export const validateTest262Completeness = evaluateTest262Completeness;

function parseArguments(argv) {
  const options = { input: "", manifests: [], expectedShardCount: undefined, expectedPathsFile: "" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index] ?? "";
    else if (arg === "--manifest") options.manifests.push(argv[++index] ?? "");
    else if (arg === "--expected-shards") options.expectedShardCount = Number.parseInt(argv[++index] ?? "", 10);
    else if (arg === "--expected-paths-file") options.expectedPathsFile = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/validate-test262-completeness.mjs --input <results.jsonl> --manifest <shard.complete.json> [--manifest ...] [--expected-shards N] [--expected-paths-file <file>]",
      );
      return null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.input) throw new Error("--input is required");
  return options;
}

function readExpectedPaths(path) {
  if (!path) return undefined;
  const text = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // A newline-delimited path file is also useful for shell-generated exact
    // filters, so fall through to that format when the content is not JSON.
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function runCli(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`Test262 completeness: ${error?.message ?? error}`);
    return 2;
  }
  if (!options) return 0;

  if (!existsSync(options.input)) {
    console.error(`Test262 completeness: missing JSONL input ${options.input}`);
    return 2;
  }
  const manifests = [];
  for (const path of options.manifests) {
    if (!path || !existsSync(path)) {
      console.error(`Test262 completeness: missing shard manifest ${path || "<empty>"}`);
      return 2;
    }
    try {
      manifests.push({ manifest: JSON.parse(readFileSync(path, "utf8")), path });
    } catch (error) {
      console.error(`Test262 completeness: malformed shard manifest ${path}: ${error?.message ?? error}`);
      return 2;
    }
  }

  let expectedPaths;
  try {
    expectedPaths = readExpectedPaths(options.expectedPathsFile);
  } catch (error) {
    console.error(`Test262 completeness: cannot read expected paths: ${error?.message ?? error}`);
    return 2;
  }
  const result = evaluateTest262Completeness(readFileSync(options.input, "utf8"), manifests, {
    expectedShardCount: options.expectedShardCount,
    expectedPaths,
  });
  if (!result.ok) {
    console.error(`INCOMPLETE: Test262 verdict evidence is not publishable (${result.errors.length} errors)`);
    for (const error of result.errors) console.error(`  - ${error.code}: ${error.message}`);
    return 2;
  }
  console.log(
    `COMPLETE: ${result.stats.shards} shard(s), ${result.stats.canonicalVerdicts} verdicts, ${result.stats.registeredTests} registered (${result.stats.explicitExclusions} explicit exclusions)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
