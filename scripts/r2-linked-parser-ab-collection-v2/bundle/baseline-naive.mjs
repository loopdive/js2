#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/r2-linked-parser-ab-collection-v2/baseline-naive.mjs — #3521 R2-v2
// RECONSTRUCTED PRE-REPAIR BASELINE. Not part of the shipping oracle.
//
// WHY THIS FILE EXISTS
// --------------------
// The 2026-08-28 independent audit proved five FALSE PASSES against the R2-v2
// collector. That collector was never committed to this repository: it lived
// only in an uncommitted working tree on the codex host, alongside the 119-line
// repair plan that was also lost. There is therefore NO original pre-repair
// code path to run a mutation against.
//
// This module reconstructs the five pre-repair check shapes the audit
// described, so that every mutation in `fixtures.mjs` can be proven
// NON-VACUOUS with runnable two-sided evidence: the mutation must PASS here and
// FAIL under `REPAIRED_STRATEGIES`. It is a RECONSTRUCTION, not the original
// collector, and no evidence produced against it may be described as an
// observation of the original code.
//
// It deliberately reuses every unrelated check from `contract.mjs` and replaces
// ONLY the five audited strategies, so a mutation's PASS/FAIL difference
// isolates exactly one defect and cannot be explained by any other divergence.

import {
  CENSUS_STATES,
  EXPECTED_CHILD_COUNT,
  SANCTIONED_EXCEPTION,
  canonicalKey,
  canonicalWatText,
  createValidator,
  sha256,
} from "./contract.mjs";

// DEFECT 5 (pre-repair). One "ran" notion stands in for attempted, spawned and
// completed: the counters are checked for internal arithmetic only, never
// against the per-child lifecycle. A child whose spawn threw therefore leaves
// the three states collapsed and undetected.
function naiveCensusCheck(report, failures) {
  const census = report.census ?? {};
  for (const state of CENSUS_STATES) {
    if (!Number.isInteger(census[state]) || census[state] < 0) {
      failures.add("census/malformed-state", null, `${state} is not a non-negative integer`);
    }
  }
  if (census.scheduled !== EXPECTED_CHILD_COUNT) {
    failures.add("census/counter-mismatch", null, `scheduled ${census.scheduled} != ${EXPECTED_CHILD_COUNT}`);
  }
  if (census.valid + census.invalid !== census.parsed) {
    failures.add("census/counter-mismatch", null, "valid + invalid does not equal parsed");
  }
}

// DEFECT 1 (pre-repair). The census only asserts that the sanctioned exception
// is PRESENT. Unitless rows beyond it are never enumerated, so an arbitrary
// extra unitless `compileDeclarations` call has nowhere to be caught.
function naiveDeclarationCensus(child, failures) {
  const key = canonicalKey(child);
  const rows = child.record?.physicalRows;
  if (!Array.isArray(rows)) {
    failures.add("declaration/malformed-census", key, "physicalRows is not an array");
    return;
  }
  const hasException = rows.some(
    (row) =>
      (row.unit === null || row.unit === undefined) &&
      row.fn === SANCTIONED_EXCEPTION.fn &&
      row.file === SANCTIONED_EXCEPTION.file &&
      row.structurallyComplete === SANCTIONED_EXCEPTION.structurallyComplete,
  );
  if (!hasException) {
    failures.add("declaration/missing-exception", key, "the graph-global module-init exception is absent");
  }
}

// DEFECT 3 (pre-repair). `map.set(key, outcome)` keeps the last writer. A
// duplicate key silently overwrites its predecessor instead of failing.
function naiveOutcomeIndex(child) {
  const byKey = new Map();
  for (const outcome of child.record?.irOutcomes ?? []) byKey.set(outcome.key, outcome);
  return byKey;
}

// DEFECT 2 (pre-repair). The join is by KEY PRESENCE only. An outcome recorded
// against the wrong file still answers to the right key, so it passes.
function naiveOutcomeJoin(child, byKey, failures) {
  if (child.route !== "prepared") return;
  const key = canonicalKey(child);
  for (const unit of child.record?.inventory?.units ?? []) {
    if (unit.kind !== "module-init") continue;
    if (!byKey.has(unit.unit)) {
      failures.add("outcome/missing-terminal", key, `prepared route has no outcome for ${unit.unit}`);
    }
  }
}

// DEFECT 4 (pre-repair). The carrier is verified by HASH ONLY, against the
// report's own manifest. Both sides are recomputed from the observed WAT, so
// the comparison is self-consistent and an i32 -> f32 parameter change is
// invisible.
function naiveWatCarriers(child, failures) {
  const key = canonicalKey(child);
  const carriers = child.record?.watCarriers;
  const manifest = child.record?.watManifest ?? {};
  if (!carriers) {
    failures.add("wat/missing-carrier", key, "watCarriers is absent");
    return;
  }
  for (const [name, observed] of Object.entries(carriers)) {
    const recomputed = sha256(canonicalWatText(observed));
    if (observed.sha256 !== recomputed || manifest[name] !== recomputed) {
      failures.add("wat/hash-mismatch", key, `carrier ${name} hash is not self-consistent`);
    }
  }
}

export const NAIVE_STRATEGIES = Object.freeze({
  id: "reconstructed-pre-repair",
  census: naiveCensusCheck,
  declarationCensus: naiveDeclarationCensus,
  outcomeIndex: naiveOutcomeIndex,
  outcomeJoin: naiveOutcomeJoin,
  watCarriers: naiveWatCarriers,
});

export const validateNaive = createValidator(NAIVE_STRATEGIES);
