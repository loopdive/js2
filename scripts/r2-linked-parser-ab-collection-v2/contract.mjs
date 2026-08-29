#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/r2-linked-parser-ab-collection-v2/contract.mjs — #3521 R2-v2 STATIC
// validation contract for the `r2-linked-parser-ab-collection-v2` adapter.
//
// WHAT THIS IS
// ------------
// The oracle half of the R2-v2 collector specified by
// plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md,
// sections "2026-08-27 R2-v2 validation plan — replace the stale switch
// oracle", "Versioned R2-v2 collection" and "Relock, run, and interpretation
// gates". It validates a COLLECTION REPORT object and nothing else: it never
// spawns a child, never invokes the compiler, and never touches a runtime.
// The 24-child collection itself may only be run under an APPROVED relock.
//
// FAIL-CLOSED STRATEGY SEAM
// -------------------------
// The five checks that the 2026-08-28 independent audit proved to be FALSE
// PASSES are isolated as named strategies. `REPAIRED_STRATEGIES` is the
// fail-closed implementation this module ships and the only one the collector
// runs. `baseline-naive.mjs` supplies `NAIVE_STRATEGIES`, a RECONSTRUCTION of
// the pre-repair shapes, so `selftest.mjs` can prove every mutation is
// NON-VACUOUS: each mutation must PASS under the naive strategy and FAIL under
// the repaired one, with every other check held identical.
//
// The reconstruction exists because the original collector was never committed
// to this repository — see the 2026-08-29 repair record on the issue.

import { createHash } from "node:crypto";

export const R2_V2_SCHEMA = "js2-r2-linked-parser-ab-collection-v2";

// --- canonical matrix -------------------------------------------------------

export const PHASE_RANK = Object.freeze(["landed-ab", "live-compat"]);
export const SIDE_RANK = Object.freeze(["base", "candidate", "live"]);
export const FIXTURE_RANK = Object.freeze(["decimal", "octal"]);
export const HOST_RANK = Object.freeze(["host", "standalone"]);
export const ROUTE_RANK = Object.freeze(["direct", "prepared"]);

export const PHASE_SIDES = Object.freeze({
  "landed-ab": Object.freeze(["base", "candidate"]),
  "live-compat": Object.freeze(["live"]),
});

// Exact pins from the issue's "Versioned R2-v2 collection" section.
export const PINS = Object.freeze({
  base: "de35a52d978e328d46a9929b5438837385ddea5b",
  candidate: "fcede269da81724397dd00bd854e3830446620f5",
  // `live` is frozen at relock time and only checked for shape + consistency.
  live: null,
});

export const HOST_OPTIONS = Object.freeze({
  host: Object.freeze({ target: "gc", nativeStrings: false }),
  standalone: Object.freeze({ target: "standalone", nativeStrings: true }),
});

// The nonexistent switch dimension. Supplying it is a schema error, never a
// third control lane.
export const FORBIDDEN_ENV_KEY = "JS2WASM_TEST_DISABLE_LINKED_STRING_PARSER_ABI";
export const FORBIDDEN_FIELD = "parserSwitch";

// The sole permitted structural exception: the immutable v1 graph-global
// unitless `compileModuleInitBody` row against `entry.mjs`.
export const SANCTIONED_EXCEPTION = Object.freeze({
  fn: "compileModuleInitBody",
  unit: null,
  source: "entry.mjs",
  file: "entry.mjs",
  kind: "module-init",
  selfOwner: "graph-global",
  disposition: "unowned-graph-global",
  structurallyComplete: false,
});

// DEFECT 4 CARRIER. The exact expected WAT ABI, carried structurally rather
// than as a hash. A hash-only carrier cannot see an i32 -> f32 parameter
// change once the report's own manifest hash is recomputed alongside it.
// These values are the committed contract; changing them requires an approved
// relock, not a collector edit.
export const EXPECTED_WAT_ABI = Object.freeze({
  parser: Object.freeze({
    name: "$js2_linked_parser_parse",
    params: Object.freeze(["i32", "i32"]),
    results: Object.freeze(["i32"]),
  }),
  caller: Object.freeze({
    name: "$js2_linked_parser_call",
    params: Object.freeze(["i32", "i32", "i32"]),
    results: Object.freeze(["i32"]),
  }),
  run: Object.freeze({
    name: "$js2_linked_parser_run",
    params: Object.freeze(["i32"]),
    results: Object.freeze(["i32"]),
  }),
});

export const WAT_CARRIERS = Object.freeze(["parser", "caller", "run"]);

export const CENSUS_STATES = Object.freeze([
  "scheduled",
  "preflightChecked",
  "attempted",
  "spawned",
  "completed",
  "parsed",
  "valid",
  "invalid",
]);

export function canonicalTuples() {
  const out = [];
  for (const fixture of FIXTURE_RANK) {
    for (const host of HOST_RANK) {
      for (const route of ROUTE_RANK) out.push({ fixture, host, route });
    }
  }
  return out;
}

export function canonicalKey(child) {
  return [child.phase, child.side, child.fixture, child.host, child.route].join("|");
}

export function expectedKeyCensus() {
  const keys = [];
  for (const phase of PHASE_RANK) {
    for (const side of PHASE_SIDES[phase]) {
      for (const t of canonicalTuples()) {
        keys.push([phase, side, t.fixture, t.host, t.route].join("|"));
      }
    }
  }
  return keys;
}

export const EXPECTED_CHILD_COUNT = expectedKeyCensus().length; // 16 + 8 = 24

function rank(child) {
  return [
    PHASE_RANK.indexOf(child.phase),
    SIDE_RANK.indexOf(child.side),
    FIXTURE_RANK.indexOf(child.fixture),
    HOST_RANK.indexOf(child.host),
    ROUTE_RANK.indexOf(child.route),
  ];
}

export function canonicalSort(children) {
  return [...children].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return 0;
  });
}

// --- deterministic serialization -------------------------------------------

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${body.join(",")}}`;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalWatText(carrier) {
  const params = (carrier?.params ?? []).map((p) => `(param ${p})`).join(" ");
  const results = (carrier?.results ?? []).map((r) => `(result ${r})`).join(" ");
  return `(func ${carrier?.name ?? ""} ${params} ${results})`.replace(/\s+/g, " ").trim();
}

// --- failure accumulator ----------------------------------------------------

class Failures {
  constructor() {
    this.list = [];
  }

  add(code, key, detail) {
    this.list.push({ code, key: key ?? null, detail });
  }

  get length() {
    return this.list.length;
  }
}

// --- strategy 5: census states ---------------------------------------------

// DEFECT 5 REPAIR. attempted / spawned / completed are SEPARATE states derived
// per child. A child whose spawn threw is attempted-but-not-spawned; the
// reported counters must agree with the per-child lifecycle exactly, so the
// three states can never collapse into one.
function repairedCensusCheck(report, failures) {
  const census = report.census ?? {};
  for (const state of CENSUS_STATES) {
    if (!Number.isInteger(census[state]) || census[state] < 0) {
      failures.add("census/malformed-state", null, `${state} is not a non-negative integer`);
    }
  }
  if (failures.length > 0) return;

  const children = report.children ?? [];
  const derived = {
    scheduled: EXPECTED_CHILD_COUNT,
    preflightChecked: children.filter((c) => c.preflightChecked === true).length,
    attempted: children.filter((c) => c.attempted === true).length,
    spawned: children.filter((c) => c.spawned === true).length,
    completed: children.filter((c) => c.completed === true).length,
    parsed: children.filter((c) => c.parsed === true).length,
    valid: children.filter((c) => c.parsed === true && c.invalid !== true).length,
    invalid: children.filter((c) => c.parsed === true && c.invalid === true).length,
  };

  for (const state of CENSUS_STATES) {
    if (census[state] !== derived[state]) {
      failures.add(
        "census/state-collapse",
        null,
        `reported ${state}=${census[state]} but the per-child lifecycle derives ${derived[state]}`,
      );
    }
  }

  const ordered = ["scheduled", "preflightChecked", "attempted", "spawned", "completed", "parsed"];
  for (let i = 1; i < ordered.length; i += 1) {
    if (derived[ordered[i - 1]] < derived[ordered[i]]) {
      failures.add(
        "census/counter-mismatch",
        null,
        `${ordered[i]} exceeds ${ordered[i - 1]} (${derived[ordered[i]]} > ${derived[ordered[i - 1]]})`,
      );
    }
  }
  if (derived.valid + derived.invalid !== derived.parsed) {
    failures.add("census/counter-mismatch", null, "valid + invalid does not equal parsed");
  }

  for (const child of children) {
    const key = canonicalKey(child);
    if (child.spawnOutcome === "threw" && (child.spawned === true || child.completed === true)) {
      failures.add("census/state-collapse", key, "a throwing spawn is marked spawned/completed");
    }
    if (child.spawned === true && child.attempted !== true) {
      failures.add("census/state-collapse", key, "spawned without attempted");
    }
    if (child.completed === true && child.spawned !== true) {
      failures.add("census/state-collapse", key, "completed without spawned");
    }
  }

  if (derived.valid !== EXPECTED_CHILD_COUNT) {
    failures.add("census/incomplete", null, `only ${derived.valid} of ${EXPECTED_CHILD_COUNT} children are valid`);
  }
}

// --- strategy 1: declaration / sole-exception census ------------------------

const EXCEPTION_FIELDS = Object.freeze([
  "fn",
  "source",
  "file",
  "kind",
  "selfOwner",
  "disposition",
  "structurallyComplete",
]);
const JOIN_FIELDS = Object.freeze(["source", "file", "kind", "selfOwner", "disposition"]);

function indexInventory(child) {
  const byUnit = new Map();
  for (const unit of child.record?.inventory?.units ?? []) byUnit.set(unit.unit, unit);
  return byUnit;
}

// DEFECT 1 REPAIR. The physical-row census is CLOSED: every row either joins an
// inventory-owned unit on all join fields, or it is the one sanctioned unitless
// exception. An arbitrary extra unitless row -- `compileDeclarations` or
// anything else -- has nowhere to land and fails closed.
function repairedDeclarationCensus(child, failures) {
  const key = canonicalKey(child);
  const rows = child.record?.physicalRows;
  if (!Array.isArray(rows)) {
    failures.add("declaration/malformed-census", key, "physicalRows is not an array");
    return;
  }
  const inventory = indexInventory(child);
  const unitless = [];

  for (const row of rows) {
    if (row.unit === null || row.unit === undefined) {
      unitless.push(row);
      continue;
    }
    const unit = inventory.get(row.unit);
    if (!unit) {
      failures.add("declaration/unjoined-row", key, `physical row ${row.fn} claims unknown unit ${row.unit}`);
      continue;
    }
    for (const field of JOIN_FIELDS) {
      if (row[field] !== unit[field]) {
        failures.add(
          "declaration/unjoined-row",
          key,
          `row ${row.fn} ${field}=${String(row[field])} does not join inventory unit ${unit.unit} ${field}=${String(unit[field])}`,
        );
      }
    }
  }

  if (unitless.length === 0) {
    failures.add("declaration/missing-exception", key, "the graph-global module-init exception is absent");
    return;
  }
  if (unitless.length > 1) {
    failures.add(
      "declaration/unsanctioned-unitless-row",
      key,
      `${unitless.length} unitless physical rows; exactly one graph-global exception is permitted (saw ${unitless
        .map((r) => r.fn)
        .join(", ")})`,
    );
  }
  for (const row of unitless) {
    for (const field of EXCEPTION_FIELDS) {
      if (row[field] !== SANCTIONED_EXCEPTION[field]) {
        failures.add(
          "declaration/unsanctioned-unitless-row",
          key,
          `unitless row ${String(row.fn)} ${field}=${String(row[field])} is not the sanctioned exception ${field}=${String(SANCTIONED_EXCEPTION[field])}`,
        );
      }
    }
  }
}

// --- strategy 3: unique outcome index ---------------------------------------

// DEFECT 3 REPAIR. Outcomes are indexed with explicit duplicate detection. The
// pre-repair `map.set(key, outcome)` silently kept the last writer, so a
// duplicate key could conceal a contradictory outcome.
function repairedOutcomeIndex(child, failures) {
  const key = canonicalKey(child);
  const outcomes = child.record?.irOutcomes ?? [];
  const byKey = new Map();
  for (const outcome of outcomes) {
    if (byKey.has(outcome.key)) {
      failures.add(
        "outcome/duplicate-key",
        key,
        `duplicate irOutcome key ${outcome.key}: ${stableStringify(byKey.get(outcome.key))} vs ${stableStringify(outcome)}`,
      );
      continue;
    }
    byKey.set(outcome.key, outcome);
  }
  return byKey;
}

// --- strategy 2: full outcome joins -----------------------------------------

// DEFECT 2 REPAIR. An outcome must join its inventory unit on EVERY field, not
// merely exist under the right key. A prepared module-init outcome recorded
// against the wrong file used to pass on key presence alone.
function repairedOutcomeJoin(child, byKey, failures) {
  const key = canonicalKey(child);
  const inventory = indexInventory(child);

  for (const outcome of byKey.values()) {
    const unit = inventory.get(outcome.unit);
    if (!unit) {
      failures.add("outcome/join-mismatch", key, `outcome ${outcome.key} claims unknown unit ${outcome.unit}`);
      continue;
    }
    if (outcome.key !== unit.unit) {
      failures.add("outcome/join-mismatch", key, `outcome key ${outcome.key} does not equal its unit ${unit.unit}`);
    }
    for (const field of JOIN_FIELDS) {
      if (outcome[field] !== unit[field]) {
        failures.add(
          "outcome/join-mismatch",
          key,
          `outcome ${outcome.key} ${field}=${String(outcome[field])} does not join inventory unit ${field}=${String(unit[field])}`,
        );
      }
    }
  }

  if (child.route !== "prepared") return;
  for (const unit of inventory.values()) {
    if (unit.kind !== "module-init") continue;
    const outcome = byKey.get(unit.unit);
    if (!outcome) {
      failures.add(
        "outcome/missing-terminal",
        key,
        `prepared route has no terminal outcome for inventory unit ${unit.unit}`,
      );
      continue;
    }
    if (outcome.outcome !== "prepared-terminal") {
      failures.add(
        "outcome/missing-terminal",
        key,
        `prepared route outcome for ${unit.unit} is ${String(outcome.outcome)}, expected prepared-terminal`,
      );
    }
  }
}

// --- strategy 4: exact WAT ABI carriers -------------------------------------

// DEFECT 4 REPAIR. The expected ABI is carried EXACTLY. Self-consistent hashing
// -- recompute the carrier hash from the observed WAT and compare it to the
// report's own manifest -- cannot see a real parameter-type change, because the
// mutation recomputes both sides. The structural comparison against
// EXPECTED_WAT_ABI can.
function repairedWatCarriers(child, failures) {
  const key = canonicalKey(child);
  const carriers = child.record?.watCarriers;
  const manifest = child.record?.watManifest ?? {};
  if (!carriers) {
    failures.add("wat/missing-carrier", key, "watCarriers is absent");
    return;
  }
  for (const name of WAT_CARRIERS) {
    const observed = carriers[name];
    const expected = EXPECTED_WAT_ABI[name];
    if (!observed) {
      failures.add("wat/missing-carrier", key, `carrier ${name} is absent`);
      continue;
    }
    if (observed.name !== expected.name) {
      failures.add("wat/abi-mismatch", key, `carrier ${name} name ${String(observed.name)} != ${expected.name}`);
    }
    const observedParams = observed.params ?? [];
    if (stableStringify(observedParams) !== stableStringify(expected.params)) {
      failures.add(
        "wat/abi-mismatch",
        key,
        `carrier ${name} params ${stableStringify(observedParams)} != expected ${stableStringify(expected.params)}`,
      );
    }
    const observedResults = observed.results ?? [];
    if (stableStringify(observedResults) !== stableStringify(expected.results)) {
      failures.add(
        "wat/abi-mismatch",
        key,
        `carrier ${name} results ${stableStringify(observedResults)} != expected ${stableStringify(expected.results)}`,
      );
    }
    const recomputed = sha256(canonicalWatText(observed));
    if (observed.sha256 !== recomputed) {
      failures.add("wat/hash-mismatch", key, `carrier ${name} sha256 does not match its own WAT text`);
    }
    if (manifest[name] !== recomputed) {
      failures.add("wat/hash-mismatch", key, `carrier ${name} sha256 does not match the report manifest`);
    }
  }
}

export const REPAIRED_STRATEGIES = Object.freeze({
  id: "repaired",
  census: repairedCensusCheck,
  declarationCensus: repairedDeclarationCensus,
  outcomeIndex: repairedOutcomeIndex,
  outcomeJoin: repairedOutcomeJoin,
  watCarriers: repairedWatCarriers,
});

// --- checks that were never in scope of the five audited defects ------------

function checkTransport(report, failures) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    failures.add("transport/malformed", null, "report is not an object");
    return false;
  }
  if (report.schema !== R2_V2_SCHEMA) {
    failures.add("transport/schema", null, `schema ${String(report.schema)} != ${R2_V2_SCHEMA}`);
  }
  if (!Array.isArray(report.children) || report.children.length === 0) {
    failures.add("transport/empty", null, "children is missing or empty");
    return false;
  }
  return failures.length === 0;
}

function checkForbiddenDimension(report, failures) {
  for (const child of report.children) {
    const key = canonicalKey(child);
    if (Object.hasOwn(child, FORBIDDEN_FIELD)) {
      failures.add("dimension/forbidden-parser-switch", key, `child carries the ${FORBIDDEN_FIELD} field`);
    }
    if (child.env && Object.hasOwn(child.env, FORBIDDEN_ENV_KEY)) {
      failures.add("dimension/forbidden-parser-switch", key, `child env carries ${FORBIDDEN_ENV_KEY}`);
    }
  }
}

function checkKeyCensus(report, failures) {
  const expected = new Set(expectedKeyCensus());
  const seen = new Set();
  for (const child of report.children) {
    if (!PHASE_RANK.includes(child.phase)) {
      failures.add("matrix/unknown-phase", canonicalKey(child), `unknown phase ${String(child.phase)}`);
      continue;
    }
    if (!(PHASE_SIDES[child.phase] ?? []).includes(child.side)) {
      failures.add(
        "matrix/unknown-side",
        canonicalKey(child),
        `side ${String(child.side)} is not in phase ${child.phase}`,
      );
      continue;
    }
    const key = canonicalKey(child);
    if (!expected.has(key)) {
      failures.add("matrix/extra-key", key, "child is outside the expected 16+8 matrix");
      continue;
    }
    if (seen.has(key)) {
      failures.add("matrix/duplicate-key", key, "duplicate canonical key");
      continue;
    }
    seen.add(key);
  }
  for (const key of expected) {
    if (!seen.has(key)) failures.add("matrix/missing-key", key, "expected child is absent");
  }
  return { expected: [...expected], observed: [...seen] };
}

function checkPins(report, failures) {
  const liveRevs = new Set();
  for (const child of report.children) {
    const key = canonicalKey(child);
    const pin = PINS[child.side];
    if (pin && child.revision !== pin) {
      failures.add("pin/mismatch", key, `side ${child.side} revision ${String(child.revision)} != ${pin}`);
    }
    if (child.side === "live") {
      if (typeof child.revision !== "string" || !/^[0-9a-f]{40}$/.test(child.revision)) {
        failures.add("pin/mismatch", key, "live revision is not a 40-hex commit");
      } else {
        liveRevs.add(child.revision);
      }
    }
    const options = HOST_OPTIONS[child.host];
    if (!options) continue;
    if (child.options?.target !== options.target || child.options?.nativeStrings !== options.nativeStrings) {
      failures.add(
        "pin/mismatch",
        key,
        `host ${child.host} options ${stableStringify(child.options ?? null)} != ${stableStringify(options)}`,
      );
    }
  }
  if (liveRevs.size > 1) {
    failures.add("pin/mismatch", null, `live phase spans ${liveRevs.size} revisions; it must be frozen at one`);
  }
}

function checkAccounting(child, failures) {
  if (!(child.side === "candidate" && child.host === "standalone" && child.route === "prepared")) return;
  const key = canonicalKey(child);
  const accounting = child.record?.accounting ?? {};
  for (const carrier of ["parser", "caller"]) {
    const entry = accounting[carrier];
    if (entry?.direct !== 1 || entry?.ir !== 1) {
      failures.add(
        "accounting/mismatch",
        key,
        `landed candidate ${carrier} accounting ${stableStringify(entry ?? null)} != {direct:1, ir:1}`,
      );
    }
  }
}

function checkDiagnostics(child, failures) {
  if (!(child.side === "base" && child.host === "standalone" && child.route === "prepared")) return;
  const key = canonicalKey(child);
  const diagnostics = child.record?.diagnostics ?? [];
  const count = (kind, carrier) => diagnostics.filter((d) => d.kind === kind && d.carrier === carrier).length;

  if (count("post-claim", "parser") !== 1 || count("compile-warning", "parser") !== 1) {
    failures.add(
      "diagnostics/parser-withdrawal",
      key,
      "historical base standalone/prepared requires exactly one parser post-claim row and its matching compile warning",
    );
  }
  const callerClaim = count("post-claim", "caller");
  const callerWarning = count("compile-warning", "caller");
  if (callerClaim !== callerWarning || callerClaim > 1) {
    failures.add(
      "diagnostics/caller-cascade",
      key,
      `caller post-claim/compile-warning must be the exact paired cascade (saw ${callerClaim}/${callerWarning})`,
    );
  }
}

// --- digests ----------------------------------------------------------------

function projectChild(child) {
  return {
    key: canonicalKey(child),
    revision: child.revision ?? null,
    options: child.options ?? null,
    physicalRows: (child.record?.physicalRows ?? []).map((r) => ({
      fn: r.fn,
      unit: r.unit ?? null,
      source: r.source,
      file: r.file,
      kind: r.kind,
      selfOwner: r.selfOwner,
      disposition: r.disposition,
      structurallyComplete: r.structurallyComplete,
    })),
    irOutcomes: (child.record?.irOutcomes ?? []).map((o) => ({
      key: o.key,
      unit: o.unit,
      source: o.source,
      file: o.file,
      kind: o.kind,
      selfOwner: o.selfOwner,
      disposition: o.disposition,
      outcome: o.outcome,
    })),
    watCarriers: child.record?.watCarriers ?? null,
  };
}

export function computeDigests(children) {
  const sorted = canonicalSort(children);
  const perPhase = {};
  for (const phase of PHASE_RANK) {
    const rows = sorted.filter((c) => c.phase === phase).map(projectChild);
    perPhase[phase] = sha256(stableStringify(rows));
  }
  return { phases: perPhase, aggregate: sha256(stableStringify(sorted.map(projectChild))) };
}

// --- validator --------------------------------------------------------------

export function createValidator(strategies = REPAIRED_STRATEGIES) {
  return function validate(report) {
    const failures = new Failures();
    if (!checkTransport(report, failures)) {
      return {
        status: "FAILED-DIAGNOSTIC-NOT-ACCEPTANCE",
        strategy: strategies.id,
        failures: failures.list,
        census: null,
        digests: null,
      };
    }

    checkForbiddenDimension(report, failures);
    const keyCensus = checkKeyCensus(report, failures);
    checkPins(report, failures);
    strategies.census(report, failures);

    for (const child of report.children) {
      if (child.record === null || child.record === undefined) continue;
      strategies.declarationCensus(child, failures);
      const byKey = strategies.outcomeIndex(child, failures);
      strategies.outcomeJoin(child, byKey, failures);
      strategies.watCarriers(child, failures);
      checkAccounting(child, failures);
      checkDiagnostics(child, failures);
    }

    return {
      status: failures.length === 0 ? "PASS" : "FAILED-DIAGNOSTIC-NOT-ACCEPTANCE",
      strategy: strategies.id,
      failures: failures.list,
      census: { expected: keyCensus.expected, observed: keyCensus.observed, counts: report.census ?? null },
      digests: computeDigests(report.children),
    };
  };
}

export const validate = createValidator(REPAIRED_STRATEGIES);
