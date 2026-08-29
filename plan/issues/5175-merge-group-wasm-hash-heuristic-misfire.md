---
id: 5175
title: "Regression gate's 'wasm-hash changed ⇒ likely real' heuristic misfired on a byte-identical binary (#5194 park)"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ci, test262-runner
goal: correctness
related: [4646, 3426, 2547]
---

# #5175 — "wasm-hash changed" misfired on a byte-identical binary

## What happened (2026-08-29, PR #5194 / issue #4646)

The merge queue auto-parked PR #5194 on a single regression:
`test/built-ins/TypedArrayConstructors/ctors/object-arg/conversion-operation-consistent-nan.js`
pass → fail, `Expected true but got false (Testing with Float64Array and
makeArray.)`. The gate reported **"Regressions with wasm-hash change: 1"**
and, with a content-current baseline, printed the "LIKELY-REAL REGRESSION —
do not dismiss" footer. One minute later a second merge-group run passed and
the queue merged the PR.

Post-merge investigation (recovery agent, 2026-08-29) found **both** gate
signals were wrong for this test:

1. **The binary is byte-identical with and without the PR's diff.** Compiling
   the runner's exact assembly for this test (real pinned harness; options
   `allowJs, skipSemanticDiagnostics, sourceMap, deferTopLevelInit,
   hostBridge:"always"`) on main and again with all seven of #4646's source
   files reverted: 242,578 bytes, same sha256, both builds. Mechanically
   expected — the compile unit contains zero class declarations, and #4646
   only touches class-identity minting. Yet the gate counted this test under
   "wasm-hash change".
2. **The failure did not reproduce: 51/51 executions pass** on content
   byte-identical to the failed merge group's tree, across four lanes
   (single-process compile+execute loop ×40, isolated vitest fresh-compile
   ×4, cached-binary ×5, whole 739-test `TypedArrayConstructors/` directory
   ×2). Verdict: flake, plausibly NaN-payload nondeterminism in the
   Float64Array store path (wasm leaves NaN bit patterns
   implementation-chosen); not observed directly.

Probes and methodology preserved by the recovery agent (shaprobe/nanloop
scripts); this issue's investigator should recreate rather than depend on a
container-lifetime worktree.

## The two defects to investigate

**(a) The hash itself.** The gate attributed a wasm-hash change to a test
whose binary is byte-identical under the diff. Find what `wasm_sha` in the
report rows actually hashes (whole binary? post-wasm-opt? including
sourceMap/name section? runner metadata?) and why it differed across the two
runs here. If the hash includes anything nondeterministic or
environment-dependent, it is noise, not signal, and every consumer of
"Regressions with wasm-hash change" inherits that.

**(b) The heuristic's discriminating power.** Even with a correct hash, "the
PR changed this test's emitted code" carries almost no weight for PRs that
shift codegen broadly — #4646 (class-identity minting) legitimately changes
hashes across a large share of the corpus. The footer's "likely-real, do not
dismiss" framing steered triage toward a wrong conclusion the gate itself
reversed one run later. Consider: report the hash-change count as data
without the verdict framing, or condition the verdict on the hash-change
being *narrow* (few tests changed hash) rather than merely present.

## Known prior art

- #3426 host-canary quarantine exists precisely because single-test flips at
  merge-group time are common enough to need machinery; this test was NOT in
  the canary manifest.
- The sibling test
  `internals/DefineOwnProperty/conversion-operation-consistent-nan.js` is
  recorded `fail` in the 2026-08-23 baseline with the same assertion family
  and passes on current main — same NaN family, opposite direction. (Could
  also be a genuine fix landed since; not bisected.)

## Acceptance criteria

1. The `wasm_sha` computation is documented (what bytes go in), and the
   #5194 discrepancy is explained — either a bug fixed, or the
   nondeterministic input identified and removed from the hash.
2. The gate's messaging no longer presents broad-codegen-PR hash changes as
   per-test "likely real" evidence (implement whichever mitigation the
   investigation supports; state what was chosen and why).
3. Consider adding the two `conversion-operation-consistent-nan` tests to the
   canary manifest if the NaN nondeterminism hypothesis survives
   investigation — with evidence, not by default.
4. No change weakens the gate's core net-negative fail: a real -1 must still
   park.

## Notes

The park itself worked as designed (#2547) — the queue re-ran, passed, and
merged without human intervention. The cost was a misdirected root-cause
investigation; the fix target is the *attribution*, not the parking.
