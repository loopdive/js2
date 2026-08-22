---
id: 4609
title: "Ratchet the equivalence baseline: 12 entries pass on current main but are still listed as known failures"
status: done
completed: 2026-08-22
sprint: current
created: 2026-08-21
updated: 2026-08-22
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: hardening
area: tests
language_feature: compiler-internals
goal: core-semantics
related: [4121]
origin: "#4121 slice 2 (PR #4720) full-capture equivalence A/B: 12 baseline entries passed with the slice ON and OFF — stale vs current main, deliberately not ratcheted in that PR"
# id 4609 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs were 4725 (introduces the issue file
# for id 4605) and none near 4609.
---

# #4609 — 12 stale known-failure entries in the equivalence baseline

## Problem

PR #4720's full-capture equivalence A/B (8 shards per leg, sets diffed by
test id) found **12 baseline known-failure entries that now pass** on
current main with the slice on AND off — i.e. they were fixed by earlier
work and the baseline never caught up: `issue-1197` ×1,
`math-pow-test262-pattern` ×1, `spec/coercion-arithmetic-add` ×8,
`symbol-basic` ×2. Recorded baseline count at that run: 36 known failures,
24 actually failing.

A stale known-failure entry is a masked regression channel: if one of these
12 breaks again, the suite reports it as "known" and stays green.

## Implementation Plan (Fable, 2026-08-21)

1. Re-measure on current main first (the 12 came from a branch base a few
   merges back): run the equivalence suite sharded (8 shards — NEVER
   unsharded on a 16GB box, it OOMs), collect the failing set, and diff
   against the baseline's known-failure list. The stale set is
   (baseline − failing); expect ≈ the 12 above but trust the measurement.
2. Remove exactly the measured stale entries from the baseline file
   (locate it via the equivalence-gate script; do not hand-edit anything
   the gate regenerates).
3. Re-run the gate to prove green with the tightened baseline, and
   deliberately re-break one removed entry in a scratch build to prove the
   gate now fails loudly on it (mutation proof, #4070 method — record the
   counterfactual here, then restore).

## Findings (2026-08-22, implementation)

### The measurement, and which `main` it belongs to

Measured **three times**, because `main` kept moving:

| run | where | base |
| --- | --- | --- |
| 1 | local, 8 shards | `03bd58c04` — the commit this branch was cut from |
| 2 | local, 8 shards | `961cea04a` — after PR #4736 landed |
| 3 | **CI**, `equivalence-shard` ×8 | branch head `a11fc84d9` = branch + `main` @ `3d1de92f0` (auto-refresh merge) |

Runs 1 and 2: eight shards, one at a time
(`SHARD=i/8 node scripts/equivalence-gate.mjs`, single-fork,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`) — the same per-shard invocation
`ci.yml`'s `equivalence-shard` matrix uses, never the unsharded run (it OOMs a
16 GB box). Per-shard partials merged and diffed against the baseline. Run 3 is
that matrix itself.

**All three agree exactly** — 1,685 tests, 1,661 passing, 24 failing, per
shard: 5 / 4 / 3 / 0 / 2 / 7 / 0 / 3. Runs 1 and 2 match by set membership,
not just by count; run 3 matches shard-for-shard and reports **no** "baseline
failure(s) now PASS" line in any shard, i.e. the tightened list still has zero
slack three bases later. So PR #4736 moved nothing in this suite, and neither
did the PRs between `961cea04a` and `3d1de92f0`.

The figures:

| | count |
| --- | --- |
| baseline `knownFailures` before | 36 |
| tests run | 1,685 (1,661 pass / 24 fail) |
| baseline entries **still failing** | 24 |
| baseline entries that **now pass** — the stale set | **12** |
| baseline entries present in neither set (renamed/deleted) | 0 |
| failing tests **not** in the baseline (real regressions) | 0 |

The count matches #4720's A/B exactly, and so does the membership.

**One local-runner caveat worth knowing.** In the second run, shard 2 was
`Terminated` (exit 143) partway through under box load and wrote **no**
partial — and the loop kept going. Merging what was on disk then read as
"1,481 tests, 4 baseline entries absent", which looks like four renamed tests
rather than one missing shard. Re-running shard 2 alone restored the full
1,685. If you merge shard partials by hand, check you have **eight** files
before believing an "absent" count.

### The measured stale set (12) — all removed

```
tests/equivalence/issue-1197.test.ts :: #1197 i32 element specialization for number[] peephole: redundant `| 0` after i32 read is folded `x | 0` collapses to nothing on an i32-shaped value
tests/equivalence/math-pow-test262-pattern.test.ts :: Math.pow/min/max with array element args (test262 pattern) Math.pow(base[i], exponent) in loop with assert_sameValue
tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add host any string + any number concatenates (§13.15.3)
tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add host any string + any string concatenates
tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add host-O any string + any number concatenates (§13.15.3)
tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add host-O any string + any string concatenates
tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add standalone any string + any number concatenates (§13.15.3)
tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add standalone any string + any string concatenates
tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add standalone-O any string + any number concatenates (§13.15.3)
tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add standalone-O any string + any string concatenates
tests/equivalence/symbol-basic.test.ts :: Symbol basic support (#471) Symbol.iterator is a constant
tests/equivalence/symbol-basic.test.ts :: Symbol basic support (#471) well-known symbols are consistent
```

`scripts/equivalence-baseline.json`: **36 → 24 entries, 12 deletions, 0
additions, 0 reorderings** — the file is not regenerated, only shrunk. The
tightened baseline now has **zero slack**: 24 listed, 24 failing.

### The 8 `coercion-arithmetic-add` entries pass WITHOUT PR #4736

Worth stating because it changes who owns what. PR #4736 (`#4606`/`#4607`
carrier stringification) reports the same 8 as "newly fixed" in its own gate
run, which reads as if that PR fixed them. It did not: they pass on **plain
`03bd58c04`**, which does not contain #4736 — it was still open and `behind`
while that run happened. The post-#4736 run at `961cea04a` returns the
identical set, which says the same thing from the other side. #4736 also does
not touch
`scripts/equivalence-baseline.json` (7 files, none of them the baseline), so
there is no conflict in either direction; its gate was simply reporting the
same pre-existing staleness this issue exists to clear.

This also settles the open box in **#4178**, whose acceptance list still says
"`scripts/equivalence-baseline.json` drops those 8 entries". Those 8 are gone
as of this change; #4178's remaining scope is the IR mixed-type-ternary bail
itself, not the baseline.

### Mutation proof — the gate now fails loudly on a removed entry

Two counterfactuals, because the first candidate mutation turned out not to
break anything (recorded below — it is a finding, not a detour).

**(a) Verdict flip on membership alone.** The same input — a merged shard
report in which `issue-1197 … 'x | 0' collapses to nothing on an i32-shaped
value` is the one failing test — scored against the baseline before and after:

| baseline | gate verdict | exit |
| --- | --- | --- |
| 36 entries (before) | `✓ No new equivalence regressions.` | **0 — masked** |
| 24 entries (after) | `✗ 1 NEW equivalence regression(s)` naming that exact id | **1 — loud** |

**(b) A real compiler mutation, run through vitest.** In
`src/codegen/typeof-delete.ts`, the `typeof` classifier's symbol arm was
changed to answer `"object"`:

```
-    if (isSymbolType(tsType)) return "symbol";
+    if (isSymbolType(tsType)) return "object";
```

`SHARD=7/8 node scripts/equivalence-gate.mjs` (the shard that owns
`symbol-basic.test.ts`, and which had **0** failures at base) then reported:

```
equivalence-gate: 2 failing, 257 passing, 24 known-failures in baseline.

✗ 2 NEW equivalence regression(s) (not in baseline):
    REGRESSION: tests/equivalence/symbol-basic.test.ts :: Symbol basic support (#471) typeof Symbol() is symbol
    REGRESSION: tests/equivalence/symbol-basic.test.ts :: Symbol basic support (#471) Symbol.iterator is a constant
gate exit=1
```

(The second of those was never a baseline entry — it is collateral from the
same mutation, and its presence is the reason the shard's failing count is 2
rather than 1.)

Under the **old** 36-entry baseline, `Symbol.iterator is a constant` was a
listed known-failure and would have been reported as "known" — exactly the
masked channel this issue is about. The mutation was reverted; `git diff src/`
is empty on the committed tree.

**First candidate mutation, and why it proved nothing (worth recording).**
The obvious target for the `issue-1197` entry was peephole Pattern 6
(`i32.const 0; i32.or` → removed, `src/codegen/peephole.ts`), since the test
asserts the triple `| 0` collapses. Disabling it changed **nothing**: shard 6
came back `7 fail / 182 pass`, byte-identical to base, and a direct probe of
`((n | 0) | 0) | 0` shows **0** `i32.or` in the WAT with the pattern off. The
`| 0` chain is already eliminated upstream, so Pattern 6 is dead for this
shape and that test no longer exercises it. A mutation that does not move the
test is not a proof — hence (b).

### Permanent pin

`tests/issue-4609-equivalence-baseline-ratchet.test.ts` keeps the ratchet
rather than leaving it as a one-time edit: it asserts none of the 12 are back
on the list, then drives the real `scripts/equivalence-gate.mjs` (in
`MERGE_PARTIALS_DIR` mode — the same set comparison, no vitest respawn) to
assert **exit 1 + `REGRESSION:`** for each removed id, and — the control that
keeps that honest — **exit 0** for an id still on the list.

Checked for vacuity the same way the rest of this issue was: re-adding
`Symbol.iterator is a constant` to the baseline turns the file **2 failed / 2
passed**; on the committed baseline it is 4/4 in 1.3 s (no compile — the gate
scores a supplied set).

## Acceptance criteria

- [x] Measured stale set recorded here — 12, listed above, measured at
      `03bd58c04` and re-measured identically at `961cea04a` and (via CI) at
      the branch head carrying `main` @ `3d1de92f0`.
- [x] Baseline tightened by exactly that set (36 → 24); equivalence gate
      green on both local merged runs and on CI's 8 shards.
- [x] Mutation proof recorded: `typeof`'s symbol arm broken → the gate names
      a removed entry as a REGRESSION and exits 1; the same input exited 0
      before the tightening.
- [x] No other baseline entries touched — the diff is 12 deletions, nothing
      else.
