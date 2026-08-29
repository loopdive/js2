#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/r2-linked-parser-ab-collection-v2/selftest.mjs — #3521 R2-v2 STATIC
// selftest and non-vacuity proof.
//
// Runs entirely on hand-built report fixtures. It never spawns a child, never
// invokes the compiler, and never runs a collection: the 24-child collection
// may only be run under an APPROVED relock.
//
// PROOF OBLIGATION
// ----------------
// For each of the five defects the 2026-08-28 independent audit proved to be a
// FALSE PASS, the mutation must:
//   1. PASS the reconstructed pre-repair baseline (reproducing the false pass);
//   2. FAIL the repaired collector with the specific expected failure code; and
//   3. differ from the canonical report ONLY in that mutation -- established by
//      both validators agreeing that the unmutated canonical report PASSES.
// A mutation that fails the baseline is vacuous and aborts the selftest.

import { computeDigests, validate } from "./contract.mjs";
import { validateNaive } from "./baseline-naive.mjs";
import { DEFECT_MUTATIONS, STRUCTURAL_MUTATIONS, buildCanonicalReport, reorderReport } from "./fixtures.mjs";

let failed = 0;
const lines = [];

function record(ok, label, detail) {
  if (!ok) failed += 1;
  lines.push(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function codes(result) {
  return [...new Set(result.failures.map((f) => f.code))];
}

const canonical = buildCanonicalReport();

// --- 0. the canonical report is accepted by BOTH validators ----------------
// This is what makes every mutation below non-vacuous: the two validators only
// diverge on the audited strategies, so a PASS/FAIL split is attributable to
// the mutation alone.
const canonicalRepaired = validate(canonical);
const canonicalNaive = validateNaive(canonical);
record(canonicalRepaired.status === "PASS", "canonical report passes the repaired collector", canonicalRepaired.status);
record(canonicalNaive.status === "PASS", "canonical report passes the reconstructed baseline", canonicalNaive.status);
record(
  canonical.children.length === 24,
  "canonical report schedules exactly 24 children",
  String(canonical.children.length),
);

if (failed > 0) {
  process.stdout.write(`${lines.join("\n")}\n\nSELFTEST ABORTED: canonical fixture is not clean\n`);
  process.exit(1);
}

// --- 1. the five audited defects, two-sided --------------------------------
lines.push("");
lines.push("five audited false passes (baseline must PASS, repaired must FAIL):");
const evidence = [];
for (const defect of DEFECT_MUTATIONS) {
  const mutated = defect.mutate(canonical);
  const naive = validateNaive(mutated);
  const repaired = validate(mutated);

  const reproduced = naive.status === "PASS";
  record(reproduced, `${defect.id} reproduces the false pass on the baseline`, `${defect.title} → ${naive.status}`);

  const rejected = repaired.status === "FAILED-DIAGNOSTIC-NOT-ACCEPTANCE";
  const hasCode = codes(repaired).includes(defect.repairedCode);
  record(
    rejected && hasCode,
    `${defect.id} fails closed on the repaired collector`,
    `${repaired.status} [${codes(repaired).join(", ")}]`,
  );

  evidence.push({
    id: defect.id,
    title: defect.title,
    baseline: naive.status,
    repaired: repaired.status,
    code: defect.repairedCode,
    observed: codes(repaired),
  });
}

// --- 2. structural selftests (repaired collector only) ---------------------
lines.push("");
lines.push("structural selftests (repaired collector must FAIL each):");
for (const mutation of STRUCTURAL_MUTATIONS) {
  const result = validate(mutation.mutate(canonical));
  const ok = result.status === "FAILED-DIAGNOSTIC-NOT-ACCEPTANCE" && codes(result).includes(mutation.code);
  record(ok, `${mutation.id} ${mutation.title}`, `${result.status} [${codes(result).join(", ")}]`);
}

// --- 3. canonical reorder must not change the digest -----------------------
lines.push("");
const reordered = reorderReport(canonical);
const digestA = computeDigests(canonical.children);
const digestB = computeDigests(reordered.children);
record(
  digestA.aggregate === digestB.aggregate,
  "canonical input reorder preserves the aggregate digest",
  digestA.aggregate.slice(0, 16),
);
for (const phase of Object.keys(digestA.phases)) {
  record(
    digestA.phases[phase] === digestB.phases[phase],
    `phase digest is reorder-stable: ${phase}`,
    digestA.phases[phase].slice(0, 16),
  );
}
record(validate(reordered).status === "PASS", "reordered canonical report still passes");

// --- report ----------------------------------------------------------------
process.stdout.write(`${lines.join("\n")}\n`);

if (process.argv.includes("--evidence")) {
  process.stdout.write(`\n${JSON.stringify({ evidence, digests: digestA }, null, 2)}\n`);
}

const total = lines.filter((l) => l.startsWith("ok  ") || l.startsWith("FAIL")).length;
process.stdout.write(`\n${total - failed}/${total} static assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
