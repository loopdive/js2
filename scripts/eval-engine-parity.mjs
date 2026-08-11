#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/eval-engine-parity.mjs — #4242 Phase 1: the eval-engine parity
// measurement artifact and its mechanical gate.
//
// WHAT THIS IS
// ------------
// A THREE-WAY diff over test262 JSONL result files:
//
//   quickjs run  ×  interpreter run  ×  the promoted standalone baseline
//
// It produces (a) a machine-readable JSON artifact and (b) the markdown table
// that gets pasted into `plan/issues/4242-quickjs-eval-default-flip.md`, and it
// evaluates the Phase-1 → Phase-2 gate mechanically so the decision is a script
// run, not a judgment call.
//
// PURE MEASUREMENT. This file changes the runtime behaviour of NO engine. It
// reads result files that already exist; it never selects, builds or runs a
// provider.
//
// TIER PINNING IS THE LOAD-BEARING SAFETY PROPERTY
// ------------------------------------------------
// Engine selection is THREE-way, not two:
//
//   REFUSAL      no env               — every dynamic-code call throws TypeError
//   INTERPRETER  TEST262_FULL_RUNTIME_EVAL=1
//   QUICKJS      JS2WASM_EVAL_ENGINE=quickjs
//
// An "interpreter" run that forgot `TEST262_FULL_RUNTIME_EVAL=1` actually
// measured the REFUSAL tier, where essentially every eval-dependent test fails
// by construction — and comparing quickjs against that yields a FAKE LANDSLIDE
// WIN. Measured live on main, 2026-08-09. So each input run must carry the
// tier its harness announced (`[test262] runtime-eval tier: …`,
// scripts/test262-import-object.mjs), and a diff whose announcements do not pin
// QUICKJS-vs-INTERPRETER is INADMISSIBLE: it is refused, never softened into a
// warning, and never emitted as if it were a valid parity artifact.
//
// Absent or unparseable provenance BLOCKS. This tool must not be able to pass
// on data it does not have.
//
// USAGE
// -----
//   node scripts/eval-engine-parity.mjs \
//     --quickjs      benchmarks/results/eval-parity/quickjs-scoped.jsonl \
//     --interpreter  benchmarks/results/eval-parity/interpreter-scoped.jsonl \
//     --baseline     .test262-cache/test262-standalone-current.jsonl \
//     --expected-files benchmarks/results/eval-parity/scoped-files.txt \
//     --quickjs-log  /tmp/test262-vitest-quickjs.log \
//     --interpreter-log /tmp/test262-vitest-interpreter.log \
//     --gate --json-out benchmarks/results/eval-parity/parity.json \
//            --markdown-out benchmarks/results/eval-parity/parity.md
//
// Re-evaluate a stored artifact (what a reviewer runs):
//   node scripts/eval-engine-parity.mjs --gate --diff-json <parity.json>
//
// OPTIONS
//   --quickjs <jsonl>          quickjs-engine run results          (required in diff mode)
//   --interpreter <jsonl>      interpreter-engine run results      (required in diff mode)
//   --baseline <jsonl>         promoted STANDALONE baseline        (required with --gate)
//   --expected-files <path>    exact requested measurement set (JSON
//                              {files:[]} / array / newline list); required by
//                              --gate unless --expected-count is supplied
//   --expected-count <n>       explicit requested row count; weaker count-only
//                              alternative to --expected-files
//   --quickjs-tier <str>       the run's announced tier, verbatim
//   --interpreter-tier <str>   ditto
//   --quickjs-log <path>       extract the tier line from a run log instead
//   --interpreter-log <path>   ditto
//   --manifest <path>          eval-dependent manifest (JSON {files:[]} or a
//                              newline-separated list); required by --full
//   --full                     full-suite mode: partition by the manifest and
//                              enforce the outside-set zero-delta invariant
//   --rules <path>             extra classification rules (JSON array), appended
//                              before the unattributed catch-all
//   --issue <path>             issue file carrying the accepted-residuals block
//                              (default plan/issues/4242-quickjs-eval-default-flip.md)
//   --drift-tolerance <n>      max interpreter-vs-baseline flips (default 10)
//   --gate                     evaluate the gate; exit non-zero when BLOCKED
//   --diff-json <path>         gate a previously produced artifact
//   --json                     print the artifact JSON to stdout
//   --markdown                 print the markdown report to stdout
//   --json-out <path>          write the artifact JSON to a file
//   --markdown-out <path>      write the markdown report to a file
//   --now <iso>                fix `generatedAt` (determinism for tests)
//
// STREAMS. Machine payloads (`--json` / `--markdown`) go to STDOUT so stdout
// stays parseable; the human report AND the verdict go to STDERR, where the
// LAST line is ALWAYS a verdict (`eval-engine-parity: OK|BLOCKED|REFUSED — …`)
// so it survives a bad pipe. Same discipline as fetch-baseline-jsonl.mjs.
//
// EXIT CODES
//   0  admissible inputs; gate PROCEED (or no --gate requested)
//   1  BLOCKED — gate failed, or the inputs are inadmissible (tier pinning)
//   2  REFUSED — usage error / unreadable input; nothing was measured

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SCHEMA_VERSION = 1;

/**
 * Bucket order is FIXED so every artifact and markdown table sorts identically
 * and diffs stay reviewable.
 */
export const BUCKET_ORDER = [
  "genuine-win",
  "scope-fidelity",
  "membrane-residual",
  "engine-difference",
  "harness-infra",
  "unattributed",
];

/**
 * Buckets whose LOSSES can never be excused by an accepted-residuals entry.
 *
 *  - `harness-infra` — the instrument is broken; the measurement itself is
 *    invalid (the #4162 lesson: an instrument artifact overwrites the real
 *    signature). Fix and re-run; never gate on it.
 *  - `unattributed`  — un-reviewed net-negatives BY CONSTRUCTION. Accepting
 *    them would accept a bucket nobody has looked at. They must first be
 *    triaged into a named bucket (extend RULES / pass `--rules`).
 */
export const NEVER_ACCEPTABLE_BUCKETS = ["harness-infra", "unattributed"];

/** Mirrors REGRESSION_BUCKET_PATH_DEPTH in scripts/diff-test262.ts (a `.ts`
 * module this `.mjs` script cannot import under plain node). Kept in lockstep
 * deliberately: the path-bucket convention must be identical across tools. */
export const REGRESSION_BUCKET_PATH_DEPTH = 5;

// ── Tier provenance ──────────────────────────────────────────────────────────

/** The tier tokens `selectCachedRuntimeEvalProvider` can announce. */
export const TIERS = ["QUICKJS", "INTERPRETER", "REFUSAL", "NONE"];

/**
 * Parse a tier announcement into its tier token.
 *
 * Accepts either the bare selection message (`INTERPRETER (key …) — …`) or the
 * full harness line (`[test262] runtime-eval tier: INTERPRETER (…) — …`).
 *
 * @param {string | undefined | null} text
 * @returns {{ tier: string | null, raw: string | null }} `tier: null` ⇒ absent
 *          or unparseable, which callers MUST treat as blocking.
 */
export function parseTierAnnouncement(text) {
  if (typeof text !== "string") return { tier: null, raw: null };
  const raw = text.trim();
  if (!raw) return { tier: null, raw: null };
  const body = raw.replace(/^(\[[^\]]*\]\s*)?runtime-eval tier:\s*/, "").trim();
  const m = /^([A-Z]+)\b/.exec(body);
  if (!m || !TIERS.includes(m[1])) return { tier: null, raw };
  // `raw` is the NORMALIZED announcement (log prefix stripped) so artifacts read
  // the same whether provenance came from --*-tier or --*-log.
  return { tier: m[1], raw: body };
}

/**
 * Extract the tier announcement from a captured run log
 * (`/tmp/test262-vitest-run.log`, written by scripts/run-test262-vitest.sh).
 *
 * The announcement is emitted ONCE per process, but a sharded/forked run has
 * several workers, so a log can carry many identical lines — and, if something
 * is misconfigured, DIFFERENT ones. Disagreement is refused rather than
 * resolved: a run that announced two tiers has no single tier.
 *
 * @param {string} logText
 * @returns {{ tier: string | null, raw: string | null, conflict: string[] }}
 */
export function extractTierFromLog(logText) {
  const seen = new Map();
  for (const line of String(logText).split("\n")) {
    if (!line.includes("runtime-eval tier:")) continue;
    const parsed = parseTierAnnouncement(line.slice(line.indexOf("runtime-eval tier:")));
    if (parsed.tier && !seen.has(parsed.tier)) seen.set(parsed.tier, parsed.raw);
  }
  const tiers = [...seen.keys()].sort();
  if (tiers.length === 0) return { tier: null, raw: null, conflict: [] };
  if (tiers.length > 1) return { tier: null, raw: null, conflict: tiers };
  return { tier: tiers[0], raw: seen.get(tiers[0]), conflict: [] };
}

// ── Result ingestion ─────────────────────────────────────────────────────────

/**
 * The statuses the test262 runner emits (tests/test262-vitest.test.ts
 * `recordResult`). Anything else is normalized to `other` rather than silently
 * counted as a pass.
 */
export const KNOWN_STATUSES = ["pass", "fail", "compile_error", "compile_timeout", "skip"];

/**
 * Parse test262 JSONL text into a `file → entry` map.
 *
 * Later rows win, matching `loadJsonl` in scripts/diff-test262.ts (a re-run of
 * the same file within one run appends). Malformed lines are counted, not
 * ignored: a file that is mostly unparseable is broken input, and the caller
 * refuses it.
 *
 * @param {string} text
 * @returns {{ map: Map<string, object>, malformed: number, rows: number }}
 */
export function parseResultsJsonl(text) {
  const map = new Map();
  let malformed = 0;
  let rows = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    rows++;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.file === "string") {
        map.set(entry.file, {
          file: entry.file,
          status: KNOWN_STATUSES.includes(entry.status) ? entry.status : "other",
          error: typeof entry.error === "string" ? entry.error : "",
          scope: typeof entry.scope === "string" ? entry.scope : undefined,
        });
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { map, malformed, rows };
}

/** Read + parse a JSONL results file. Throws a REFUSED-worthy error if absent. */
export function readResultsFile(path) {
  if (!existsSync(path)) throw new Error(`results file not found: ${path}`);
  const parsed = parseResultsJsonl(readFileSync(path, "utf8"));
  if (parsed.map.size === 0) throw new Error(`results file has no usable rows: ${path}`);
  if (parsed.malformed > 0 && parsed.malformed >= parsed.rows / 2) {
    throw new Error(`results file is more than half unparseable (${parsed.malformed}/${parsed.rows}): ${path}`);
  }
  return parsed;
}

/** @param {Map<string, object>} map @param {Iterable<string>} files */
function summarize(map, files) {
  const counts = { pass: 0, fail: 0, compile_error: 0, compile_timeout: 0, skip: 0, other: 0, total: 0 };
  for (const file of files) {
    const entry = map.get(file);
    if (!entry) continue;
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    counts.total++;
  }
  return counts;
}

const isPass = (entry) => entry?.status === "pass";

// ── Classification rules ─────────────────────────────────────────────────────

/**
 * Ordered rule table; FIRST MATCH WINS.
 *
 * ORDERING DEVIATION FROM THE PLAN, deliberate: the plan lists `win` first and
 * `harness-infra` fifth. Here `harness-infra` is checked FIRST, because a link
 * error / missing artifact / timeout on EITHER side means the instrument
 * broke — and with `win` first, a quickjs pass against an interpreter LINK
 * ERROR would be laundered into a "genuine win", i.e. the exact fake-win class
 * tier pinning exists to prevent. Harness-infra WINS do not block (the gate
 * blocks on harness-infra LOSSES), so the stricter order costs nothing.
 *
 * The scope-fidelity / membrane-residual / engine-difference patterns below are
 * the families named in the #4242 plan (#4238 §4 and #4245 §5). The #4245
 * residual list is explicitly "resolved-at-implementation-time" — its final
 * error texts do not exist yet — so these are the best available approximation
 * and are meant to be REFINED, either by editing this table or by passing
 * `--rules extra.json` at measurement time. Everything they miss lands in
 * `unattributed`, which BLOCKS the gate. That is the intended failure
 * direction: an unmatched loss stops the flip until a human triages it.
 *
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} bucket
 * @property {"win" | "loss" | "any"} kind which flip direction may match
 * @property {string[]} [pathPatterns] regex sources tested against the file path
 * @property {string[]} [errorPatterns] regex sources tested against error text
 * @property {"failing" | "any"} [errorScope] whose error text (default failing side)
 * @property {string[]} [statuses] the failing side's status must be one of these
 * @property {string} description
 */
/** @type {Rule[]} */
export const DEFAULT_RULES = [
  {
    id: "H1",
    bucket: "harness-infra",
    kind: "any",
    errorScope: "any",
    errorPatterns: [
      'Import #\\d+ module="js2wasm:runtime-eval"',
      "\\bLinkError\\b",
      "\\bCompileError\\b",
      "runtime-eval provider",
      "quickjs (artifact|adapter)",
      "could not create a runtime/context",
      "extern leaked outside the provider namespace",
      "\\btimed out\\b",
    ],
    description: "link / artifact / instantiation / timeout — the instrument, not the engine",
  },
  {
    id: "H2",
    bucket: "harness-infra",
    kind: "any",
    statuses: ["compile_timeout", "other"],
    description: "compile timeout or unrecognized status — measurement is not trustworthy",
  },
  {
    id: "W1",
    bucket: "genuine-win",
    kind: "win",
    description: "quickjs passes where the interpreter does not",
  },
  {
    id: "S1",
    bucket: "scope-fidelity",
    kind: "loss",
    pathPatterns: ["language/eval-code/", "language/expressions/call/eval-"],
    errorPatterns: ["new\\.target", "\\bsuper\\b"],
    description: "new.target / super in direct eval (#4238 §4, #4194 census)",
  },
  {
    id: "S2",
    bucket: "scope-fidelity",
    kind: "loss",
    pathPatterns: ["(^|/)var-env-", "/eval-code/.*var-", "var-decl"],
    description: "var-env EvalDeclarationInstantiation approximation (#4238 §4 residual 2)",
  },
  {
    id: "S3",
    bucket: "scope-fidelity",
    kind: "loss",
    pathPatterns: ["language/eval-code/"],
    errorPatterns: ["strict", "caller", "write-back"],
    description: "strict-caller write-back residual",
  },
  {
    id: "S4",
    bucket: "scope-fidelity",
    kind: "loss",
    errorPatterns: ["\\barguments\\b"],
    description: "mapped-arguments severing across the eval boundary",
  },
  {
    id: "S5",
    bucket: "scope-fidelity",
    kind: "loss",
    errorPatterns: ["before initialization", "\\bTDZ\\b", "temporal dead zone"],
    description: "TDZ interleaving between caller scope and eval code",
  },
  {
    id: "M1",
    bucket: "membrane-residual",
    kind: "loss",
    errorPatterns: ["\\binstanceof\\b", "getPrototypeOf", "prototype chain", "__proto__"],
    description: "proto-chain crossing / instanceof through the membrane (#4245 §5)",
  },
  {
    id: "M2",
    bucket: "membrane-residual",
    kind: "loss",
    errorPatterns: ["defineProperty", "descriptor", "getOwnPropertyDescriptor", "\\bwritable\\b", "configurable"],
    description: "descriptor fidelity / defineProperty on a wrapper (#4245 §5)",
  },
  {
    id: "M3",
    bucket: "membrane-residual",
    kind: "loss",
    errorPatterns: ["Symbol\\(", "\\bsymbol-keyed\\b", "Symbol\\."],
    description: "Symbol-keyed access through the membrane (#4245 §5)",
  },
  {
    id: "M4",
    bucket: "membrane-residual",
    kind: "loss",
    errorPatterns: ["isArray"],
    description: "Array.isArray on a wrapper (#4245 §5)",
  },
  {
    id: "M5",
    bucket: "membrane-residual",
    kind: "loss",
    errorPatterns: ["Exception: undefined", "opaque", "\\btombstone\\b", "revoked"],
    description: "outward trap-error flattening / tombstone TypeError (#4245 §5)",
  },
  {
    id: "E1",
    bucket: "engine-difference",
    kind: "loss",
    pathPatterns: ["annexB/built-ins/Function/", "annexB/language/eval-code/"],
    description: "Annex B legacy Function / eval behaviours where QuickJS diverges",
  },
  {
    id: "E2",
    bucket: "engine-difference",
    kind: "loss",
    errorPatterns: ["RegExp", "\\bregular expression\\b"],
    description: "RegExp-in-eval engine difference",
  },
  {
    id: "E3",
    bucket: "engine-difference",
    kind: "loss",
    errorPatterns: ["expected message", "message mismatch", "Expected SameValue"],
    description: "error-message text the test asserts verbatim",
  },
  {
    id: "U1",
    bucket: "unattributed",
    kind: "loss",
    description: "unmatched loss — MUST be triaged; blocks the gate by construction",
  },
];

const anyMatch = (patterns, text) => patterns.some((p) => new RegExp(p).test(text));

/**
 * Classify one flip against the ordered rule table.
 *
 * @param {{ file: string, kind: "win"|"loss", failingStatus: string, failingError: string, otherError: string }} flip
 * @param {Rule[]} rules
 * @returns {{ bucket: string, rule: string }}
 */
export function classifyFlip(flip, rules = DEFAULT_RULES) {
  for (const rule of rules) {
    if (rule.kind !== "any" && rule.kind !== flip.kind) continue;
    if (rule.pathPatterns && !anyMatch(rule.pathPatterns, flip.file)) continue;
    if (rule.errorPatterns) {
      const scope = rule.errorScope === "any" ? `${flip.failingError}\n${flip.otherError}` : flip.failingError;
      if (!anyMatch(rule.errorPatterns, scope)) continue;
    }
    if (rule.statuses && !rule.statuses.includes(flip.failingStatus)) continue;
    return { bucket: rule.bucket, rule: rule.id };
  }
  // Unreachable while U1 (catch-all loss) is present, but a `--rules` file that
  // replaces the table must not silently produce an unclassified flip.
  return { bucket: "unattributed", rule: "U0" };
}

/**
 * Compose the effective rule table: extra rules from `--rules` are inserted
 * BEFORE the `unattributed` catch-all and AFTER the built-ins, so a measurement
 * can refine attribution (shrinking `unattributed`) without being able to
 * re-label a harness-infra break as an engine result.
 *
 * @param {Rule[]} extra
 * @returns {Rule[]}
 */
export function composeRules(extra = []) {
  const isCatchAll = (rule) => rule.bucket === "unattributed";
  return [...DEFAULT_RULES.filter((r) => !isCatchAll(r)), ...extra, ...DEFAULT_RULES.filter(isCatchAll)];
}

/** Validate a `--rules` payload. Invalid rules REFUSE; they never load partially. */
export function validateRules(raw) {
  if (!Array.isArray(raw)) throw new Error("rules file must contain a JSON array");
  for (const rule of raw) {
    if (!rule || typeof rule.id !== "string" || !rule.id) throw new Error("rule is missing a string `id`");
    if (!BUCKET_ORDER.includes(rule.bucket)) {
      throw new Error(
        `rule ${rule.id}: bucket ${JSON.stringify(rule.bucket)} is not one of ${BUCKET_ORDER.join(", ")}`,
      );
    }
    if (!["win", "loss", "any"].includes(rule.kind)) throw new Error(`rule ${rule.id}: kind must be win|loss|any`);
    for (const key of ["pathPatterns", "errorPatterns"]) {
      if (rule[key] === undefined) continue;
      if (!Array.isArray(rule[key])) throw new Error(`rule ${rule.id}: ${key} must be an array`);
      for (const pattern of rule[key]) new RegExp(pattern); // throws on a bad regex
    }
  }
  return raw;
}

// ── The three-way diff ───────────────────────────────────────────────────────

/**
 * Build the parity artifact.
 *
 * The MEASURED SET is the INTERSECTION of the two engine runs: comparing a file
 * only one engine executed is not a comparison. Any asymmetry is recorded in
 * `set_mismatch` and blocks the gate — the runs were not like-with-like.
 *
 * @param {object} opts
 * @returns {object} the artifact (schema in the #4242 plan §P1.3)
 */
export function buildParityArtifact(opts) {
  const {
    quickjs,
    interpreter,
    baseline = null,
    tiers,
    mode = "scoped",
    manifest = null,
    expectedFiles = null,
    expectedCount = null,
    rules = DEFAULT_RULES,
  } = opts;

  const qFiles = new Set(quickjs.map.keys());
  const iFiles = new Set(interpreter.map.keys());
  const measured = [...qFiles].filter((f) => iFiles.has(f)).sort();
  const onlyQuickjs = [...qFiles].filter((f) => !iFiles.has(f)).sort();
  const onlyInterpreter = [...iFiles].filter((f) => !qFiles.has(f)).sort();

  const expectedKind = expectedFiles ? "files" : Number.isInteger(expectedCount) ? "count" : null;
  const expectedFileSet = expectedFiles ? new Set(expectedFiles) : null;
  const expectedSize = expectedFileSet?.size ?? (Number.isInteger(expectedCount) ? expectedCount : null);
  const missingQuickjs = expectedFileSet ? [...expectedFileSet].filter((f) => !qFiles.has(f)).sort() : [];
  const missingInterpreter = expectedFileSet ? [...expectedFileSet].filter((f) => !iFiles.has(f)).sort() : [];
  const unexpectedQuickjs = expectedFileSet ? [...qFiles].filter((f) => !expectedFileSet.has(f)).sort() : [];
  const unexpectedInterpreter = expectedFileSet ? [...iFiles].filter((f) => !expectedFileSet.has(f)).sort() : [];
  const expectedComplete =
    expectedKind === "files"
      ? missingQuickjs.length === 0 &&
        missingInterpreter.length === 0 &&
        unexpectedQuickjs.length === 0 &&
        unexpectedInterpreter.length === 0
      : expectedKind === "count"
        ? qFiles.size === expectedSize && iFiles.size === expectedSize
        : false;

  const inside = manifest ? measured.filter((f) => manifest.has(f)) : measured;
  const outside = manifest ? measured.filter((f) => !manifest.has(f)) : [];

  const flips = [];
  const neutral = [];
  const buckets = Object.fromEntries(BUCKET_ORDER.map((b) => [b, { wins: 0, losses: 0, net: 0, files: [] }]));

  for (const file of inside) {
    const q = quickjs.map.get(file);
    const i = interpreter.map.get(file);
    if (isPass(q) === isPass(i)) {
      if (q.status !== i.status) neutral.push(file);
      continue;
    }
    const kind = isPass(q) ? "win" : "loss";
    const failing = kind === "win" ? i : q;
    const other = kind === "win" ? q : i;
    const { bucket, rule } = classifyFlip(
      {
        file,
        kind,
        failingStatus: failing.status,
        failingError: failing.error ?? "",
        otherError: other.error ?? "",
      },
      rules,
    );
    const b = baseline?.map.get(file);
    flips.push({
      file,
      kind,
      interpreter: i.status,
      quickjs: q.status,
      baseline: b ? b.status : null,
      error: firstLine(failing.error),
      bucket,
      rule,
      path_bucket: file.split("/").slice(0, REGRESSION_BUCKET_PATH_DEPTH).join("/"),
    });
    buckets[bucket][kind === "win" ? "wins" : "losses"]++;
    buckets[bucket].files.push(file);
  }
  for (const bucket of Object.values(buckets)) {
    bucket.net = bucket.wins - bucket.losses;
    bucket.files.sort();
  }
  flips.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const summary = {
    quickjs: summarize(quickjs.map, inside),
    interpreter: summarize(interpreter.map, inside),
    baseline: baseline ? summarize(baseline.map, inside) : null,
    net_vs_interpreter: 0,
  };
  summary.net_vs_interpreter = summary.quickjs.pass - summary.interpreter.pass;

  const outsideFlips = outside.filter((f) => isPass(quickjs.map.get(f)) !== isPass(interpreter.map.get(f))).sort();

  return {
    schema_version: SCHEMA_VERSION,
    generatedAt: opts.now ?? new Date().toISOString(),
    generated_by: "scripts/eval-engine-parity.mjs",
    inputs: {
      quickjs: { path: quickjs.path ?? null, tier: tiers.quickjs.tier, tier_announcement: tiers.quickjs.raw },
      interpreter: {
        path: interpreter.path ?? null,
        tier: tiers.interpreter.tier,
        tier_announcement: tiers.interpreter.raw,
      },
      baseline: baseline ? { path: baseline.path ?? null } : null,
    },
    admissible: tiers.quickjs.tier === "QUICKJS" && tiers.interpreter.tier === "INTERPRETER",
    set: {
      mode,
      manifest: opts.manifestPath ?? null,
      files: inside.length,
      outside_files: outside.length,
    },
    set_mismatch: {
      count: onlyQuickjs.length + onlyInterpreter.length,
      only_quickjs: onlyQuickjs,
      only_interpreter: onlyInterpreter,
    },
    expected_set: {
      kind: expectedKind,
      source: opts.expectedFilesPath ?? null,
      count: expectedSize,
      files: expectedFileSet ? [...expectedFileSet].sort() : null,
      quickjs_count: qFiles.size,
      interpreter_count: iFiles.size,
      complete: expectedComplete,
      missing_quickjs: missingQuickjs,
      missing_interpreter: missingInterpreter,
      unexpected_quickjs: unexpectedQuickjs,
      unexpected_interpreter: unexpectedInterpreter,
    },
    summary,
    sanity: baseline
      ? {
          baseline_provided: true,
          interpreter_vs_baseline_flips: inside.filter(
            (f) => baseline.map.has(f) && isPass(baseline.map.get(f)) !== isPass(interpreter.map.get(f)),
          ).length,
          baseline_missing_files: measured.filter((f) => !baseline.map.has(f)).length,
          baseline_missing_file_paths: measured.filter((f) => !baseline.map.has(f)).sort(),
        }
      : {
          baseline_provided: false,
          interpreter_vs_baseline_flips: null,
          baseline_missing_files: null,
          baseline_missing_file_paths: null,
        },
    neutral_status_changes: { count: neutral.length, files: neutral.sort() },
    flips,
    buckets,
    outside_set_delta: { count: outsideFlips.length, files: outsideFlips },
  };
}

const firstLine = (text) => (typeof text === "string" && text ? text.split("\n")[0].slice(0, 200) : null);

// ── accepted-residuals ───────────────────────────────────────────────────────

/**
 * Extract the `accepted-residuals` block from the issue file.
 *
 * The block is a fenced code block whose body carries the marker comment
 * `accepted-residuals (#4242)`. `//` line comments are stripped before parsing
 * (the plan writes it as jsonc).
 *
 * A block that is present but MALFORMED is an error, not an absence: silently
 * treating unparseable approvals as "no approvals" would flip a BLOCK into a
 * different-but-also-wrong verdict, and treating it as approval would accept
 * something nobody wrote.
 *
 * @param {string} issueText
 * @returns {{ entries: object[], present: boolean }}
 */
export function parseAcceptedResiduals(issueText) {
  const fences = String(issueText).match(/```[a-z]*\n[\s\S]*?```/g) ?? [];
  const block = fences.find((f) => f.includes("accepted-residuals (#4242)"));
  if (!block) return { entries: [], present: false };
  const body = block
    .replace(/^```[a-z]*\n/, "")
    .replace(/```$/, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`accepted-residuals block is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("accepted-residuals block must be a JSON array");
  for (const entry of parsed) {
    for (const key of ["bucket", "rationale", "approved_by", "date"]) {
      if (typeof entry?.[key] !== "string" || !entry[key].trim()) {
        throw new Error(`accepted-residuals entry is missing a non-empty \`${key}\``);
      }
    }
    if (!Number.isInteger(entry.count_ceiling) || entry.count_ceiling < 0) {
      throw new Error(`accepted-residuals entry for ${entry.bucket} needs an integer count_ceiling >= 0`);
    }
    if (!BUCKET_ORDER.includes(entry.bucket)) {
      throw new Error(`accepted-residuals entry names unknown bucket ${JSON.stringify(entry.bucket)}`);
    }
    if (NEVER_ACCEPTABLE_BUCKETS.includes(entry.bucket)) {
      throw new Error(
        `accepted-residuals entry names ${entry.bucket}, which can never be accepted — ` +
          `triage those losses into a named bucket first`,
      );
    }
  }
  return { entries: parsed, present: true };
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * Evaluate the Phase-1 gate. Pure — drive it directly from a fixture artifact.
 *
 * Invariants (all evaluated; every failure is reported, the first is the
 * verdict line):
 *   G1 tier pinning — quickjs run announced QUICKJS, interpreter run announced
 *      INTERPRETER (and NOT REFUSAL). Absent/unparseable ⇒ BLOCKED.
 *   G2 set integrity — identical measured sets, non-empty, and exactly equal
 *      to the explicitly recorded requested file set/count. Two identically
 *      truncated runs are incomplete, not like-for-like evidence.
 *   G3 net ≥ 0, OR every net-negative bucket has an accepted-residuals entry
 *      whose count_ceiling covers its losses.
 *   G4 harness-infra and unattributed LOSSES are zero. Never excusable.
 *   G5 full mode — outside-set delta is exactly zero.
 *   G6 sanity — a baseline covers every measured file and interpreter-vs-
 *      baseline drift is within tolerance (otherwise the interpreter reference
 *      is untrustworthy).
 *
 * @param {object} artifact
 * @param {{ entries: object[], present: boolean }} accepted
 * @param {{ driftTolerance?: number }} [opts]
 * @returns {{ verdict: "PROCEED" | "BLOCKED", reason: string, reasons: string[], unaccepted_negative_buckets: string[] }}
 */
export function evaluateGate(artifact, accepted = { entries: [], present: false }, opts = {}) {
  const driftTolerance = opts.driftTolerance ?? 10;
  const reasons = [];

  // G1 — tier pinning.
  const q = artifact.inputs?.quickjs ?? {};
  const i = artifact.inputs?.interpreter ?? {};
  if (q.tier !== "QUICKJS") {
    reasons.push(
      `tier-pinning: the quickjs run announced ${q.tier ?? "NO PARSEABLE TIER"} — ` +
        `a parity artifact without QUICKJS provenance is inadmissible`,
    );
  }
  if (i.tier !== "INTERPRETER") {
    reasons.push(
      `tier-pinning: the interpreter run announced ${i.tier ?? "NO PARSEABLE TIER"} — ` +
        (i.tier === "REFUSAL"
          ? "the REFUSAL tier throws on every dynamic-code call, so this diff is a FAKE landslide win, not parity"
          : "TEST262_FULL_RUNTIME_EVAL=1 is required for the authoritative interpreter tier"),
    );
  }

  // G2 — set integrity.
  if ((artifact.set_mismatch?.count ?? 0) > 0) {
    reasons.push(
      `set integrity: ${artifact.set_mismatch.count} file(s) were executed by only one engine ` +
        `(${artifact.set_mismatch.only_quickjs.length} quickjs-only, ` +
        `${artifact.set_mismatch.only_interpreter.length} interpreter-only) — the runs are not like-with-like`,
    );
  }
  if (!artifact.set?.files) reasons.push("set integrity: the measured set is empty — nothing was compared");
  const expectedKind = artifact.expected_set?.kind;
  const expectedCount = artifact.expected_set?.count;
  const recordedFiles = artifact.expected_set?.files;
  if (
    !["files", "count"].includes(expectedKind) ||
    !Number.isInteger(expectedCount) ||
    expectedCount <= 0 ||
    (expectedKind === "files" &&
      (!Array.isArray(recordedFiles) ||
        recordedFiles.length !== expectedCount ||
        new Set(recordedFiles).size !== expectedCount))
  ) {
    reasons.push(
      "set integrity: no valid expected measurement set/count was recorded — identically truncated runs cannot be detected",
    );
  } else if (!artifact.expected_set.complete) {
    const expected = artifact.expected_set;
    const details =
      expected.kind === "files"
        ? `${expected.missing_quickjs.length} missing + ${expected.unexpected_quickjs.length} unexpected quickjs; ` +
          `${expected.missing_interpreter.length} missing + ${expected.unexpected_interpreter.length} unexpected interpreter`
        : `expected ${expected.count}, got quickjs ${expected.quickjs_count} and interpreter ${expected.interpreter_count}`;
    reasons.push(`set integrity: measured runs do not match the requested ${expected.kind} set (${details})`);
  }

  // G4 — never-acceptable buckets (checked before G3 so its verdict wins on ties
  // with an otherwise net-positive result).
  for (const bucket of NEVER_ACCEPTABLE_BUCKETS) {
    const losses = artifact.buckets?.[bucket]?.losses ?? 0;
    if (losses > 0) {
      reasons.push(
        `${bucket}: ${losses} loss(es) — ${
          bucket === "harness-infra"
            ? "the measurement itself is broken; fix and re-run, never gate on it"
            : "un-triaged net-negatives; classify them into a named bucket first"
        }`,
      );
    }
  }

  // G3 — net, or per-bucket acceptance.
  const net = artifact.summary?.net_vs_interpreter ?? 0;
  const unaccepted = [];
  if (net < 0) {
    for (const [name, bucket] of Object.entries(artifact.buckets ?? {})) {
      if (bucket.net >= 0) continue;
      if (NEVER_ACCEPTABLE_BUCKETS.includes(name)) {
        unaccepted.push(name); // already reported by G4; keep it visible here too
        continue;
      }
      const entry = accepted.entries.find((e) => e.bucket === name);
      if (!entry) {
        unaccepted.push(name);
        reasons.push(`net ${net} with no accepted-residuals entry for net-negative bucket \`${name}\``);
      } else if (entry.count_ceiling < bucket.losses) {
        unaccepted.push(name);
        reasons.push(
          `bucket \`${name}\` has ${bucket.losses} losses, above its approved count_ceiling ${entry.count_ceiling}`,
        );
      }
    }
  }

  // G5 — full mode outside-set invariant.
  if (artifact.set?.mode === "full" && (artifact.outside_set_delta?.count ?? 0) > 0) {
    reasons.push(
      `outside-set delta: ${artifact.outside_set_delta.count} file(s) outside the eval-dependent manifest ` +
        `changed pass-ness — the engine flip may not carry a regression class it does not own`,
    );
  }

  // G6 — baseline cross-check.
  if (!artifact.sanity?.baseline_provided) {
    reasons.push("sanity: no standalone baseline supplied — the interpreter run has no cross-check");
  } else if ((artifact.sanity.baseline_missing_files ?? 0) > 0) {
    reasons.push(
      `sanity: standalone baseline is missing ${artifact.sanity.baseline_missing_files} measured file(s) — ` +
        `the interpreter run has no complete cross-check`,
    );
  } else if (artifact.sanity.interpreter_vs_baseline_flips > driftTolerance) {
    reasons.push(
      `sanity: interpreter run differs from the promoted baseline on ` +
        `${artifact.sanity.interpreter_vs_baseline_flips} file(s) (tolerance ${driftTolerance}) — ` +
        `the interpreter reference is not trustworthy; re-run`,
    );
  }

  return {
    verdict: reasons.length === 0 ? "PROCEED" : "BLOCKED",
    reason: reasons[0] ?? `net ${net >= 0 ? `+${net}` : net} on ${artifact.set?.files ?? 0} measured files`,
    reasons,
    unaccepted_negative_buckets: [...new Set(unaccepted)].sort(),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Render the markdown table pasted into the issue file. Deterministic. */
export function renderMarkdown(artifact) {
  const s = artifact.summary;
  const lines = [];
  lines.push(`## Parity Measurement (Phase 1) — #4242`, "");
  if (!artifact.admissible) {
    lines.push(
      `> **INADMISSIBLE** — tier provenance does not pin QUICKJS vs INTERPRETER. Do not cite these numbers.`,
      "",
    );
  }
  lines.push(`Generated ${artifact.generatedAt} by \`${artifact.generated_by}\` (${artifact.set.mode} mode).`, "");
  lines.push(`| provenance | value |`, `| --- | --- |`);
  lines.push(`| quickjs results | \`${artifact.inputs.quickjs.path ?? "—"}\` |`);
  lines.push(`| quickjs tier | ${codeOrDash(artifact.inputs.quickjs.tier_announcement)} |`);
  lines.push(`| interpreter results | \`${artifact.inputs.interpreter.path ?? "—"}\` |`);
  lines.push(`| interpreter tier | ${codeOrDash(artifact.inputs.interpreter.tier_announcement)} |`);
  lines.push(`| baseline | \`${artifact.inputs.baseline?.path ?? "—"}\` |`);
  lines.push(
    `| expected set | ${artifact.expected_set?.kind ? `${artifact.expected_set.kind} (${artifact.expected_set.count})` : "**absent**"} |`,
  );
  lines.push(`| measured files | ${artifact.set.files} |`, "");
  lines.push(`| engine | pass | fail | compile_error | skip | total |`, `| --- | --- | --- | --- | --- | --- |`);
  for (const name of ["quickjs", "interpreter", "baseline"]) {
    const c = s[name];
    if (!c) continue;
    lines.push(`| ${name} | ${c.pass} | ${c.fail} | ${c.compile_error} | ${c.skip} | ${c.total} |`);
  }
  lines.push("", `**net vs interpreter: ${signed(s.net_vs_interpreter)}**`, "");
  lines.push(`| bucket | wins | losses | net |`, `| --- | --- | --- | --- |`);
  for (const name of BUCKET_ORDER) {
    const b = artifact.buckets[name];
    lines.push(`| ${name} | ${b.wins} | ${b.losses} | ${signed(b.net)} |`);
  }
  lines.push("");
  const losses = artifact.flips.filter((f) => f.kind === "loss");
  if (losses.length > 0) {
    lines.push(`### Losses (${losses.length})`, "", `| file | bucket | rule | quickjs | interpreter | error |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const f of losses) {
      lines.push(`| \`${f.file}\` | ${f.bucket} | ${f.rule} | ${f.quickjs} | ${f.interpreter} | ${mdCell(f.error)} |`);
    }
    lines.push("");
  }
  if (artifact.gate) {
    lines.push(`**Gate: ${artifact.gate.verdict}** — ${artifact.gate.reason}`, "");
  }
  return lines.join("\n");
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const codeOrDash = (text) => (text ? `\`${text.replace(/\|/g, "\\|")}\`` : "**absent**");
const mdCell = (text) => (text ? text.replace(/\|/g, "\\|") : "—");

/** Render the human-readable stderr report (everything except the verdict). */
export function renderReport(artifact) {
  const s = artifact.summary;
  const lines = [
    `eval-engine-parity — ${artifact.set.mode} mode, ${artifact.set.files} measured files`,
    `  quickjs tier:     ${artifact.inputs.quickjs.tier ?? "UNPARSEABLE"}`,
    `  interpreter tier: ${artifact.inputs.interpreter.tier ?? "UNPARSEABLE"}`,
    `  pass: quickjs ${s.quickjs.pass} vs interpreter ${s.interpreter.pass} (net ${signed(s.net_vs_interpreter)})`,
  ];
  for (const name of BUCKET_ORDER) {
    const b = artifact.buckets[name];
    if (b.wins === 0 && b.losses === 0) continue;
    lines.push(`  ${name.padEnd(18)} wins ${b.wins}  losses ${b.losses}  net ${signed(b.net)}`);
  }
  if (artifact.set_mismatch.count > 0) lines.push(`  set mismatch: ${artifact.set_mismatch.count} file(s)`);
  if (artifact.expected_set?.kind) {
    lines.push(
      `  expected set: ${artifact.expected_set.kind} ${artifact.expected_set.count} ` +
        `(${artifact.expected_set.complete ? "complete" : "INCOMPLETE"})`,
    );
  } else {
    lines.push("  expected set: ABSENT");
  }
  if (artifact.sanity.baseline_provided) {
    lines.push(`  interpreter vs baseline flips: ${artifact.sanity.interpreter_vs_baseline_flips}`);
    if (artifact.sanity.baseline_missing_files > 0) {
      lines.push(`  baseline missing measured files: ${artifact.sanity.baseline_missing_files}`);
    }
  }
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

class Refused extends Error {}

const USAGE = `eval-engine-parity — #4242 three-way eval-engine parity diff + gate

  --quickjs <jsonl>         quickjs-engine run results        (diff mode, required)
  --interpreter <jsonl>     interpreter-engine run results    (diff mode, required)
  --baseline <jsonl>        promoted STANDALONE baseline      (required with --gate)
  --expected-files <path>   exact requested file set          (preferred with --gate)
  --expected-count <n>      requested row count               (count-only alternative)
  --quickjs-tier <str> | --quickjs-log <path>           tier provenance (required)
  --interpreter-tier <str> | --interpreter-log <path>   tier provenance (required)
  --manifest <path>         eval-dependent manifest (required by --full)
  --full                    full-suite mode + outside-set zero-delta invariant
  --rules <path>            extra classification rules (JSON array)
  --issue <path>            accepted-residuals source (default ${"plan/issues/4242-quickjs-eval-default-flip.md"})
  --drift-tolerance <n>     max interpreter-vs-baseline flips (default 10)
  --gate                    evaluate the gate; non-zero exit when BLOCKED
  --diff-json <path>        gate a previously produced artifact
  --json | --markdown       print the artifact / report to stdout (pick one)
  --json-out <path> | --markdown-out <path>             write to files
  --now <iso>               fix generatedAt (determinism for tests)

stdout carries machine payloads only; the report and the verdict go to stderr,
where the LAST line is always \`eval-engine-parity: OK|BLOCKED|REFUSED — …\`.
Exit 0 pass · 1 blocked · 2 refused (usage / unreadable input).`;

function parseArgs(argv) {
  const opts = { flags: new Set() };
  const valued = new Set([
    "--quickjs",
    "--interpreter",
    "--baseline",
    "--expected-files",
    "--expected-count",
    "--quickjs-tier",
    "--interpreter-tier",
    "--quickjs-log",
    "--interpreter-log",
    "--manifest",
    "--rules",
    "--issue",
    "--diff-json",
    "--json-out",
    "--markdown-out",
    "--drift-tolerance",
    "--now",
  ]);
  const known = new Set([...valued, "--gate", "--full", "--json", "--markdown", "--help", "-h"]);
  for (let idx = 0; idx < argv.length; idx++) {
    const arg = argv[idx];
    if (!known.has(arg)) throw new Refused(`unknown argument ${JSON.stringify(arg)}`);
    if (valued.has(arg)) {
      const value = argv[++idx];
      if (value === undefined || value.startsWith("--")) throw new Refused(`${arg} needs a value`);
      if (arg === "--drift-tolerance" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
        // A NaN tolerance would make every `flips > tolerance` comparison false,
        // i.e. silently disable invariant G6. Refuse instead.
        throw new Refused(`--drift-tolerance must be a non-negative integer, got ${JSON.stringify(value)}`);
      }
      if (arg === "--expected-count" && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
        throw new Refused(`--expected-count must be a positive integer, got ${JSON.stringify(value)}`);
      }
      opts[arg.slice(2)] = value;
    } else {
      opts.flags.add(arg.slice(2));
    }
  }
  return opts;
}

/** Resolve one engine's tier provenance from `--<engine>-tier` or `--<engine>-log`. */
function resolveTier(engine, opts) {
  const literal = opts[`${engine}-tier`];
  const logPath = opts[`${engine}-log`];
  if (literal && logPath) throw new Refused(`pass only one of --${engine}-tier / --${engine}-log`);
  if (literal) {
    const parsed = parseTierAnnouncement(literal);
    if (!parsed.tier) throw new Refused(`--${engine}-tier is not a parseable tier announcement: ${literal}`);
    return parsed;
  }
  if (logPath) {
    if (!existsSync(logPath)) throw new Refused(`--${engine}-log not found: ${logPath}`);
    const found = extractTierFromLog(readFileSync(logPath, "utf8"));
    if (found.conflict.length > 0) {
      throw new Refused(`--${engine}-log announces conflicting tiers (${found.conflict.join(", ")})`);
    }
    if (!found.tier) throw new Refused(`--${engine}-log carries no \`runtime-eval tier:\` announcement: ${logPath}`);
    return found;
  }
  throw new Refused(
    `missing tier provenance for the ${engine} run — pass --${engine}-tier "<announcement>" or ` +
      `--${engine}-log <run log>. A parity artifact without tier provenance is inadmissible (#4242).`,
  );
}

function loadManifest(path) {
  const text = readFileSync(path, "utf8");
  let files;
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    const parsed = JSON.parse(text);
    files = Array.isArray(parsed) ? parsed : parsed.files;
    if (!Array.isArray(files)) throw new Refused(`manifest ${path} has no \`files\` array`);
  } else {
    files = text.split("\n").filter((line) => line.trim());
  }
  return new Set(files.map((f) => String(f).trim()));
}

function loadExpectedFiles(path) {
  const files = loadManifest(path);
  if (files.has("")) throw new Refused(`expected-files ${path} contains an empty file name`);
  if (files.size === 0) throw new Refused(`expected-files ${path} is empty — a zero-row gate is vacuous`);
  return files;
}

function writeOut(path, text) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

function buildFromInputs(opts) {
  for (const required of ["quickjs", "interpreter"]) {
    if (!opts[required]) throw new Refused(`--${required} <results.jsonl> is required`);
  }
  const gate = opts.flags.has("gate");
  const full = opts.flags.has("full");
  if (gate && !opts.baseline) {
    throw new Refused("--gate requires --baseline <standalone jsonl> (the interpreter run's cross-check)");
  }
  if (opts["expected-files"] && opts["expected-count"]) {
    throw new Refused("pass only one of --expected-files / --expected-count");
  }
  if (gate && !opts["expected-files"] && !opts["expected-count"]) {
    throw new Refused(
      "--gate requires --expected-files <requested-set> or --expected-count <n>; " +
        "otherwise identically truncated runs can pass",
    );
  }
  if (full && !opts.manifest) throw new Refused("--full requires --manifest <path> to partition inside/outside set");

  const load = (path) => ({ ...readResultsFile(path), path });
  const artifact = buildParityArtifact({
    quickjs: load(opts.quickjs),
    interpreter: load(opts.interpreter),
    baseline: opts.baseline ? load(opts.baseline) : null,
    tiers: { quickjs: resolveTier("quickjs", opts), interpreter: resolveTier("interpreter", opts) },
    mode: full ? "full" : "scoped",
    manifest: opts.manifest ? loadManifest(opts.manifest) : null,
    manifestPath: opts.manifest ?? null,
    expectedFiles: opts["expected-files"] ? loadExpectedFiles(opts["expected-files"]) : null,
    expectedFilesPath: opts["expected-files"] ?? null,
    expectedCount: opts["expected-count"] ? Number(opts["expected-count"]) : null,
    rules: opts.rules ? composeRules(validateRules(JSON.parse(readFileSync(opts.rules, "utf8")))) : DEFAULT_RULES,
    now: opts.now,
  });
  return artifact;
}

const DEFAULT_ISSUE = "plan/issues/4242-quickjs-eval-default-flip.md";

function loadAccepted(opts) {
  const path = opts.issue ?? DEFAULT_ISSUE;
  if (!existsSync(path)) return { entries: [], present: false, path, missing: true };
  return { ...parseAcceptedResiduals(readFileSync(path, "utf8")), path, missing: false };
}

/**
 * @param {string[]} argv
 * @param {{ out: (s: string) => void, err: (s: string) => void }} io
 * @returns {number} process exit code
 */
export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.err(`eval-engine-parity: REFUSED — ${err.message}\n`);
    return 2;
  }
  if (opts.flags.has("help") || argv.length === 0) {
    io.err(`${USAGE}\n`);
    io.err("eval-engine-parity: REFUSED — nothing measured (usage above)\n");
    return 2;
  }
  if (opts.flags.has("json") && opts.flags.has("markdown")) {
    io.err("eval-engine-parity: REFUSED — --json and --markdown both write stdout; pick one, or use --*-out\n");
    return 2;
  }

  let artifact;
  let accepted;
  try {
    artifact = opts["diff-json"] ? JSON.parse(readFileSync(opts["diff-json"], "utf8")) : buildFromInputs(opts);
    accepted = loadAccepted(opts);
  } catch (err) {
    io.err(`eval-engine-parity: REFUSED — ${err.message}\n`);
    return 2;
  }

  // Tier pinning is enforced whether or not --gate was asked for: emitting an
  // inadmissible artifact as if it were a measurement is the hazard itself.
  const gateOpts = { driftTolerance: opts["drift-tolerance"] ? Number(opts["drift-tolerance"]) : undefined };
  const gate = evaluateGate(artifact, accepted, gateOpts);
  const tierReasons = gate.reasons.filter((reason) => reason.startsWith("tier-pinning"));

  if (opts.flags.has("gate")) {
    artifact.gate = {
      verdict: gate.verdict,
      reason: gate.reason,
      reasons: gate.reasons,
      unaccepted_negative_buckets: gate.unaccepted_negative_buckets,
      accepted_residuals: { source: accepted.path, present: accepted.present, entries: accepted.entries },
    };
  }

  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const markdown = renderMarkdown(artifact);
  if (opts["json-out"]) writeOut(opts["json-out"], json);
  if (opts["markdown-out"]) writeOut(opts["markdown-out"], markdown);
  if (opts.flags.has("json")) io.out(json);
  if (opts.flags.has("markdown")) io.out(`${markdown}\n`);

  io.err(`${renderReport(artifact)}\n`);
  if (opts.flags.has("gate")) for (const reason of gate.reasons) io.err(`  BLOCK: ${reason}\n`);

  if (opts.flags.has("gate")) {
    const ok = gate.verdict === "PROCEED";
    io.err(`eval-engine-parity: ${ok ? "OK" : "BLOCKED"} — ${gate.reason}\n`);
    return ok ? 0 : 1;
  }
  if (tierReasons.length > 0) {
    io.err(`eval-engine-parity: BLOCKED — ${tierReasons[0]}\n`);
    return 1;
  }
  io.err(`eval-engine-parity: OK — diff written (no --gate requested)\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
