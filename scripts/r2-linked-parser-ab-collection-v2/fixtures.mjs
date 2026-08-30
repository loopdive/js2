#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/r2-linked-parser-ab-collection-v2/fixtures.mjs — #3521 R2-v2 static
// fixture builder and mutation operators.
//
// Builds a synthetic but fully canonical 24-child R2-v2 collection report and
// the mutations the selftest drives through it. Nothing here compiles, spawns,
// or executes anything: the fixture is a hand-built report object standing in
// for a collection that only an APPROVED relock may ever run.

import {
  EXPECTED_WAT_ABI,
  HOST_OPTIONS,
  OWNED_MODULE_INIT,
  OWNED_MODULE_INIT_OUTCOME,
  OWNED_MODULE_INIT_PHYSICAL,
  PHASE_SIDES,
  PHASE_RANK,
  PINS,
  R2_V2_SCHEMA,
  SANCTIONED_EXCEPTION,
  WAT_CARRIERS,
  canonicalTuples,
  canonicalWatText,
  sha256,
} from "./contract.mjs";

// Frozen at relock time; a synthetic 40-hex stand-in for the static fixture.
export const FIXTURE_LIVE_REVISION = "1111111111111111111111111111111111111111";

function watCarriers(host) {
  const abiByHost = EXPECTED_WAT_ABI[host];
  if (!abiByHost) throw new Error(`fixture invariant broken: unknown host ${host}`);
  const out = {};
  for (const name of WAT_CARRIERS) {
    const abi = abiByHost[name];
    const carrier = { params: [...abi.params], results: [...abi.results] };
    carrier.sha256 = sha256(canonicalWatText(name, carrier));
    out[name] = carrier;
  }
  return out;
}

function watManifest(carriers) {
  const out = {};
  for (const name of WAT_CARRIERS) out[name] = carriers[name].sha256;
  return out;
}

function physicalRows() {
  // The owned empty.mjs initializer remains a direct legacy physical root in
  // BOTH tuple routes. The second row is the sole immutable graph-global
  // exception, also once per child.
  return [{ ...OWNED_MODULE_INIT, ...OWNED_MODULE_INIT_PHYSICAL }, { ...SANCTIONED_EXCEPTION }];
}

function irOutcomes() {
  return [
    {
      key: OWNED_MODULE_INIT.unit,
      ...OWNED_MODULE_INIT,
      ...OWNED_MODULE_INIT_OUTCOME,
    },
  ];
}

function diagnostics(side, host, route) {
  if (!(side === "base" && host === "standalone" && route === "prepared")) return [];
  // The reviewed parser parity withdrawal: parser post-claim plus its matching
  // compile warning are mandatory; the caller cascade is absent here, which is
  // permitted only because BOTH of its rows are absent together.
  return [
    { kind: "post-claim", carrier: "stringToNumber" },
    { kind: "compile-warning", carrier: "stringToNumber" },
  ];
}

function accounting(side, host, route) {
  if (!(side === "candidate" && host === "standalone" && route === "prepared")) return {};
  return {
    stringToNumber: { direct: 1, ir: 1 },
    readNumber: { direct: 1, ir: 1 },
    run: { direct: 1, ir: 0 },
  };
}

function buildChild(phase, side, tuple, ordinal) {
  const carriers = watCarriers(tuple.host);
  return {
    ordinal,
    phase,
    side,
    fixture: tuple.fixture,
    host: tuple.host,
    route: tuple.route,
    revision: PINS[side] ?? FIXTURE_LIVE_REVISION,
    options: { ...HOST_OPTIONS[tuple.host] },
    env: {},
    preflightChecked: true,
    attempted: true,
    spawned: true,
    completed: true,
    parsed: true,
    invalid: false,
    spawnOutcome: "ok",
    exit: 0,
    signal: null,
    timedOut: false,
    record: {
      inventory: { units: [{ ...OWNED_MODULE_INIT }] },
      physicalRows: physicalRows(),
      irOutcomes: irOutcomes(),
      watCarriers: carriers,
      watManifest: watManifest(carriers),
      diagnostics: diagnostics(side, tuple.host, tuple.route),
      accounting: accounting(side, tuple.host, tuple.route),
    },
  };
}

export function buildCanonicalReport() {
  const children = [];
  let ordinal = 0;
  for (const phase of PHASE_RANK) {
    for (const side of PHASE_SIDES[phase]) {
      for (const tuple of canonicalTuples()) {
        children.push(buildChild(phase, side, tuple, ordinal));
        ordinal += 1;
      }
    }
  }
  return {
    schema: R2_V2_SCHEMA,
    adapter: "r2-linked-parser-ab-collection-v2",
    census: {
      scheduled: children.length,
      preflightChecked: children.length,
      attempted: children.length,
      spawned: children.length,
      completed: children.length,
      parsed: children.length,
      valid: children.length,
      invalid: 0,
    },
    children,
  };
}

export function clone(report) {
  return JSON.parse(JSON.stringify(report));
}

function findChild(report, predicate) {
  const child = report.children.find(predicate);
  if (!child) throw new Error("fixture invariant broken: target child not found");
  return child;
}

const preparedStandaloneCandidate = (c) =>
  c.side === "candidate" && c.host === "standalone" && c.route === "prepared" && c.fixture === "decimal";

// --- the five audited defects ----------------------------------------------

// D1: an arbitrary extra UNITLESS `compileDeclarations` call.
export function mutateExtraUnitlessDeclaration(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  child.record.physicalRows.push({
    fn: "compileDeclarations",
    unit: null,
    source: "entry.mjs",
    file: "entry.mjs",
    kind: "declarations",
    selfOwner: "graph-global",
    disposition: "unowned-graph-global",
    structurallyComplete: true,
  });
  return next;
}

// D2: a direct-legacy module-init outcome recorded against the WRONG FILE.
export function mutateWrongFileOutcome(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  child.record.irOutcomes[0].file = "other.mjs";
  return next;
}

// D3: a DUPLICATE outcome key carrying a contradictory outcome.
export function mutateDuplicateOutcomeKey(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  const first = child.record.irOutcomes[0];
  child.record.irOutcomes.push({ ...first, outcome: "unexpected-terminal" });
  return next;
}

// D4: stringToNumber's SECOND WAT PARAMETER changed i32 -> f32, with every
// hash recomputed so the report stays self-consistent.
export function mutateParserSecondParamType(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  const stringToNumber = child.record.watCarriers.stringToNumber;
  stringToNumber.params[1] = "f32";
  stringToNumber.sha256 = sha256(canonicalWatText("stringToNumber", stringToNumber));
  child.record.watManifest.stringToNumber = stringToNumber.sha256;
  return next;
}

// D5: a spawn that THREW, with the attempted/spawned/completed states collapsed
// into one another exactly as the pre-repair census reported them.
export function mutateCollapsedSpawnCensus(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  child.spawnOutcome = "threw";
  child.spawned = false;
  child.completed = false;
  child.parsed = false;
  child.record = null;
  // The collapse: the census still reports all three states at full count.
  next.census.parsed = next.children.length - 1;
  next.census.valid = next.children.length - 1;
  return next;
}

export const DEFECT_MUTATIONS = Object.freeze([
  {
    id: "D1",
    title: "arbitrary extra unitless compileDeclarations call",
    mutate: mutateExtraUnitlessDeclaration,
    repairedCode: "declaration/unsanctioned-unitless-row",
  },
  {
    id: "D2",
    title: "wrong-file direct-legacy module-init outcome",
    mutate: mutateWrongFileOutcome,
    repairedCode: "outcome/join-mismatch",
  },
  {
    id: "D3",
    title: "duplicate outcome key",
    mutate: mutateDuplicateOutcomeKey,
    repairedCode: "outcome/duplicate-key",
  },
  {
    id: "D4",
    title: "stringToNumber second WAT parameter i32 -> f32, hashes recomputed",
    mutate: mutateParserSecondParamType,
    repairedCode: "wat/abi-mismatch",
  },
  {
    id: "D5",
    title: "attempted/spawned/completed collapse when spawn throws",
    mutate: mutateCollapsedSpawnCensus,
    repairedCode: "census/state-collapse",
  },
]);

// --- production-evidence relock mutations -----------------------------------
// These records are not claims about the lost collector. They prove that the
// reconstructed hash/presence baseline remains permissive while the relocked
// production model rejects the host, route, physical-row, and terminal drift.

export function mutateWrongHostAbi(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  const carriers = watCarriers("host");
  child.record.watCarriers = carriers;
  child.record.watManifest = watManifest(carriers);
  return next;
}

export function mutateWrongModuleInitRoute(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  child.record.irOutcomes[0].bodyRoute = "prepared";
  return next;
}

export function mutateWrongPhysicalRow(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  const row = child.record.physicalRows.find((candidate) => candidate.unit === OWNED_MODULE_INIT.unit);
  if (!row) throw new Error("fixture invariant broken: owned physical row not found");
  row.fn = "compileDeclarations";
  return next;
}

export function mutateWrongModuleInitOutcome(report) {
  const next = clone(report);
  const child = findChild(next, preparedStandaloneCandidate);
  child.record.irOutcomes[0].outcome = "prepared-terminal";
  return next;
}

export const PRODUCTION_MUTATIONS = Object.freeze([
  {
    id: "P1",
    title: "standalone child carrying the host physical ABI, hashes recomputed",
    mutate: mutateWrongHostAbi,
    repairedCode: "wat/abi-mismatch",
  },
  {
    id: "P2",
    title: "prepared outer tuple inventing a prepared module-init route",
    mutate: mutateWrongModuleInitRoute,
    repairedCode: "outcome/terminal-mismatch",
  },
  {
    id: "P3",
    title: "owned module-init physical row using compileDeclarations",
    mutate: mutateWrongPhysicalRow,
    repairedCode: "declaration/physical-row-mismatch",
  },
  {
    id: "P4",
    title: "owned module-init terminal outcome rewritten as prepared-terminal",
    mutate: mutateWrongModuleInitOutcome,
    repairedCode: "outcome/terminal-mismatch",
  },
]);

// --- structural mutations (never in scope of the five false passes) ---------

export const STRUCTURAL_MUTATIONS = Object.freeze([
  {
    id: "S1",
    title: "dropped canonical key",
    code: "matrix/missing-key",
    mutate: (r) => {
      const next = clone(r);
      next.children.splice(3, 1);
      next.census.scheduled = next.children.length;
      return next;
    },
  },
  {
    id: "S2",
    title: "duplicate canonical key",
    code: "matrix/duplicate-key",
    mutate: (r) => {
      const next = clone(r);
      next.children.push(clone(next.children[0]));
      return next;
    },
  },
  {
    id: "S3",
    title: "wrong side for phase",
    code: "matrix/unknown-side",
    mutate: (r) => {
      const next = clone(r);
      next.children[0].side = "live";
      return next;
    },
  },
  {
    id: "S4",
    title: "forbidden parserSwitch field",
    code: "dimension/forbidden-parser-switch",
    mutate: (r) => {
      const next = clone(r);
      next.children[0].parserSwitch = "disabled";
      return next;
    },
  },
  {
    id: "S5",
    title: "forbidden switch environment variable",
    code: "dimension/forbidden-parser-switch",
    mutate: (r) => {
      const next = clone(r);
      next.children[0].env.JS2WASM_TEST_DISABLE_LINKED_STRING_PARSER_ABI = "1";
      return next;
    },
  },
  {
    id: "S6",
    title: "malformed transport",
    code: "transport/malformed",
    mutate: () => "not-a-report",
  },
  {
    id: "S7",
    title: "empty transport",
    code: "transport/empty",
    mutate: (r) => {
      const next = clone(r);
      next.children = [];
      return next;
    },
  },
  {
    id: "S8",
    title: "missing graph-global exception",
    code: "declaration/missing-exception",
    mutate: (r) => {
      const next = clone(r);
      const child = findChild(next, preparedStandaloneCandidate);
      child.record.physicalRows = child.record.physicalRows.filter((row) => row.unit !== null);
      return next;
    },
  },
  {
    id: "S9",
    title: "duplicate graph-global exception",
    code: "declaration/unsanctioned-unitless-row",
    mutate: (r) => {
      const next = clone(r);
      const child = findChild(next, preparedStandaloneCandidate);
      child.record.physicalRows.push({ ...SANCTIONED_EXCEPTION });
      return next;
    },
  },
  {
    id: "S10",
    title: "mutated graph-global exception (structurallyComplete flipped)",
    code: "declaration/unsanctioned-unitless-row",
    mutate: (r) => {
      const next = clone(r);
      const child = findChild(next, preparedStandaloneCandidate);
      const row = child.record.physicalRows.find((x) => x.unit === null);
      row.structurallyComplete = true;
      return next;
    },
  },
  {
    id: "S11",
    title: "wrong landed-A/B pin",
    code: "pin/mismatch",
    mutate: (r) => {
      const next = clone(r);
      next.children[0].revision = "0".repeat(40);
      return next;
    },
  },
  {
    id: "S12",
    title: "extra tuple outside the 16+8 matrix",
    code: "matrix/extra-key",
    mutate: (r) => {
      const next = clone(r);
      const extra = clone(next.children[0]);
      extra.fixture = "hex";
      next.children.push(extra);
      return next;
    },
  },
  {
    id: "S13",
    title: "unknown phase",
    code: "matrix/unknown-phase",
    mutate: (r) => {
      const next = clone(r);
      next.children[0].phase = "third-lane";
      return next;
    },
  },
  {
    id: "S14",
    title: "missing direct-legacy module-init terminal outcome",
    code: "outcome/missing-terminal",
    mutate: (r) => {
      const next = clone(r);
      const child = findChild(next, preparedStandaloneCandidate);
      child.record.irOutcomes = [];
      return next;
    },
  },
  {
    id: "S15",
    title: "live phase spanning two revisions",
    code: "pin/mismatch",
    mutate: (r) => {
      const next = clone(r);
      const live = next.children.filter((c) => c.side === "live");
      live[0].revision = "2".repeat(40);
      return next;
    },
  },
  {
    id: "S16",
    title: "unpaired caller cascade on the historical base withdrawal",
    code: "diagnostics/caller-cascade",
    mutate: (r) => {
      const next = clone(r);
      const child = findChild(
        next,
        (c) => c.side === "base" && c.host === "standalone" && c.route === "prepared" && c.fixture === "decimal",
      );
      child.record.diagnostics.push({ kind: "post-claim", carrier: "readNumber" });
      return next;
    },
  },
]);

export function reorderReport(report) {
  const next = clone(report);
  next.children.reverse();
  return next;
}
