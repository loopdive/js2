---
id: 5280
title: "test262 flake: class-definition-null-proto-super.js overflows the stack under merge-group load and parks unrelated PRs"
status: done
created: 2026-09-02
updated: 2026-09-02
completed: 2026-09-02
sprint: current
priority: high
horizon: m
feasibility: medium
task_type: infrastructure
area: tooling
goal: ci-infrastructure
requested_by: claude/fable-ir-takeover
related: [5275, 2547, 3426, 3457, 2562, 5479, 5480, 5486]
---

## Problem

`test/language/statements/class/subclass/class-definition-null-proto-super.js`
flips `pass → fail` with `Maximum call stack size exceeded` (`range_error`,
regression bucket signature **`96690aa5e0efb4ff`**, net −1) in the
`merge_group` re-validation, non-deterministically. It has parked **three
unrelated PRs in one day**:

| PR | parked | run | what the PR changed |
| --- | --- | --- | --- |
| #5479 | 2026-09-02 12:15 | 33626922676 | ES2015 standalone TypedArray r2 — builtins/prototype graph |
| #5480 | 2026-09-02 14:51 | 33642323854 | #3523 gap-6a v2 — module-init prelift, default-OFF (byte-neutral) |
| #5486 | 2026-09-02 21:33 | 33683869984 | #3521 R2-T1/G1 — telemetry + CI selection (302/302 byte-identical) |

Three disjoint diffs, one row, one signature. Two of the three PRs carry their
own byte-identity evidence, and #5480's diagnosis measured the row directly:
runner-faithful `runTest262File`, 3 runs each, `origin/main` **pass ×3** and
the PR tree **pass ×3**, identical `wasm_sha` `aa0313d0d7f6`. The compiled
artifact is the same on both sides — nothing in a PR diff selects the outcome.
Each park costs a full ~20-minute matrix cycle plus the re-admission cycle, and
stalls whatever is queued behind it.

Each park was diagnosed by hand and re-admitted once; every re-admission then
passed. That is three hand-diagnoses of the same row.

## Why the existing machinery does not catch it

- The **canary quarantine** (#3426) reports `0 observed transitions excluded`
  for this row: its manifest was built from two same-SHA canary runs
  (29632875780, 29643714720) whose 932 union-eligible paths do not include
  this file. The row is flaky but was not flaky *in those two runs*.
- The **`LIKELY-REAL` banner** (#2562) fires because the baseline is
  content-current (0 test262-relevant commits behind main HEAD). Content
  currency says nothing about whether a row is deterministic, so the banner
  actively argues against the correct call here.
- The **cross-PR signature hint** in the gate's own footer ("Same signature on
  another PR ⇒ identical cluster ⇒ likely baseline drift") is printed but not
  acted on: nothing compares this run's signature against other recent runs'.

## Implementation Plan

Two independent pieces; either alone is worth landing.

1. **Root-cause the overflow.** The failure is a real stack overflow in the
   compiled module (or in the harness driving it), not a compile error — the
   test builds a `class extends` chain whose prototype is `null`. Find whether
   the recursion is in the emitted `[[Construct]]` path, in the runner's
   harness assembly, or in the interpreter's own stack budget under a loaded
   runner (the shards run at pool ≥ 3). If it is our recursion, bound it; if
   it is a stack-budget interaction, raise or pin the budget for that shard.
   The reduced witness is the test file itself — it passes standalone and
   fails only under merge-group load, so reproduce with the shard's real
   concurrency, not a single-file run.
2. **Make the cross-PR signature check load-bearing.** The gate already
   computes the bucket signature and already prints the hint. Persist recent
   `merge_group` signatures (the run artifacts are retained ~1 day, which is
   enough) and, when the same signature appears on a PR whose diff is disjoint
   from the previous one's, downgrade the verdict from `LIKELY-REAL` to a
   flake candidate — or route it into the #3426 canary manifest automatically.
   This is the piece that stops the next three hand-diagnoses.

## Acceptance criteria

1. The row either passes deterministically under shard-level concurrency, or
   is in the canary manifest with the evidence that put it there.
2. A second unrelated PR hitting an identical bucket signature is reported as
   such by the gate itself, without a human comparing two run logs.
3. No PR is parked on this row again without the gate naming the prior
   occurrence.

## 2026-09-02 implementation checkpoint

Both pieces landed. Measured on a 4-core / 15 GB container — the same shape as
`ubuntu-latest`, which is what makes the shard reproduction faithful.

### 1. Root cause of the overflow — found, reproduced, fixed

**It is our recursion, and it is order-dependent, not stack-budget-dependent.**

The host-side class-parent registry (`src/runtime/class-static-parent.ts`) is
**process-global and keyed by class NAME**. A shard worker compiles and runs
hundreds of test262 files in one process, and `C` is among the corpus's most
common class names. `registerClassParent` dropped a **null** value on the floor
(`if (value != null) …`), so `class C extends null` could not overwrite a
PREVIOUS file's `C` entry. The SuperCall then resolved the stale parent through
`__call_dynamic_class_parent_0` and `Reflect.apply`'d it instead of throwing
TypeError. When the stale parent resolved back into the current module's own
`C`, the SuperCall re-entered itself without bound → `Maximum call stack size
exceeded`.

Evidence, in the order it was obtained:

| # | Measurement | Result |
| --- | --- | --- |
| 1 | `runTest262File` on the witness, 3 runs (the path the earlier hand diagnoses used) | pass ×3, `wasm_sha aa0313d0d7f6` — **and zero `class_parent` imports** |
| 2 | Host row from the parked run 33683869984 (artifact 9867999215) | `status: fail`, `error: "Maximum call stack size exceeded"`, `host_import_leak_class: dynamic_object_property`, **`imports` include `env::__call_dynamic_class_parent_0` and `env::__register_class_parent`**, no `wasm_sha` at all, `retried: true` |
| 3 | Full merge-group shard replica — `tests/test262-chunk-dynamic.test.ts`, `TEST262_CHUNK_INDEX=7 TEST262_CHUNK_TOTAL=52`, `COMPILER_POOL_SIZE=4`, 936 rows, 586 s | witness **pass**, and it carries `host_import_leak_class: dynamic_object_property` — i.e. the shard path takes the DYNAMIC heritage route that the in-process runner never takes |
| 4 | Pool-1 worker, predecessor `.../subclass/derived-class-return-override-catch-super.js`, then the witness | witness **fail: `Maximum call stack size exceeded`** — the literal CI failure and bucket `96690aa5e0efb4ff`, reproduced from process ORDER alone |
| 5 | Same, predecessor `.../subclass/superclass-bound-function.js` (which itself passes) | witness fail: `Expected a TypeError to be thrown but no exception was thrown at all` — the standalone lane's row in the same parked run |
| 6 | Steps 4 and 5 after the fix | witness **pass** in every case |

Measurement 1 is why three hand diagnoses missed this: the runner-faithful
`runTest262File` path compiles the witness **without** the dynamic class-parent
imports, so it never exercises the registry at all. It cannot reproduce the
failure at any stack size — sweeping V8 `--stack-size` from 984 KB down to
120 KB keeps the row passing, and at 100 KB it is the COMPILER that overflows
(`src/ir/fnctor-method-edges.ts:501`), not the executed module. The stack budget
was never the variable; the worker's process history was.

**Fix** (`src/runtime/class-static-parent.ts`, `src/runtime.ts`): an explicit
`extends null` is now recorded under a `NULL_PARENT` sentinel, `getClassParent`
answers `null` for it and stops (no fall-through to a stale lazy resolver), and
`_registerClassParentHandler` no longer returns early on a null heritage.
`class C extends null` therefore throws the spec's TypeError deterministically,
whatever ran before it. Regression test:
`tests/issue-5280-class-parent-null-heritage.test.ts`. The test file itself was
NOT skipped, quarantined or deleted.

Not fixed here, and worth its own issue: the registry is still name-keyed and
process-global, so two same-named classes with DIFFERENT non-null parents in one
worker still collide. `extends null` was the case that could not self-correct;
a non-null heritage at least overwrites.

### 2. Cross-PR signature check — now load-bearing

`diff-test262.ts` has printed the #2098 bucket signature and the hint "Same
signature on another PR ⇒ identical cluster ⇒ likely baseline drift" since
#2098, and nothing ever acted on it. Now:

- the gate writes the signature as a machine-readable sidecar
  (`TEST262_SIGNATURE_OUT`, env-gated so an unset variable changes nothing);
- `Cross-PR bucket-signature ledger (#5280)` persists each merge_group's record
  as a run artifact named `test262-bucket-sig-<signature>` and looks up prior
  occurrences by exact artifact name — the same mechanism #1956 uses for
  `test262-group-<sha>`. 1-day retention covers the observed window (the three
  parks landed inside nine hours);
- when the same signature already failed on a **different PR whose
  test262-relevant diff is disjoint** from this group's, the failure banner
  becomes `CROSS-PR FLAKE CANDIDATE`, naming the prior PR, run id and log URL,
  and explicitly supersedes the #2562 `LIKELY-REAL` banner — which answers a
  different question (is the baseline content-current?) and, on 2026-09-02, gave
  the opposite of the correct answer.

Deliberate limits, so the gate is not weakened:

- **A signature seen once stays `first-occurrence`** and the #2562 banner and
  the exit code are untouched. That is the case a genuine single-PR regression
  falls into.
- **A re-run of the same PR** is `repeat-same-pr` — named, never downgraded.
- **Overlapping test262-relevant diffs** are `overlapping-diff` — a shared file
  is a plausible shared cause, so it stays a real regression.
- **An unresolvable diff never counts as disjoint.** `pathsDisjoint` refuses an
  empty path set, so a failed `git diff` cannot manufacture a downgrade.
- The ledger changes the VERDICT TEXT and the evidence, never the pass/fail
  decision. Re-admission stays a human action.
- Relevance is decided by `scripts/test262-paths-match.sh --list` — the same
  classifier the `changes` job and the #2562 staleness step use, so the ledger's
  notion of "relevant" cannot drift from the gate's.

Unit tests: `tests/issue-5280-signature-ledger.test.ts` (7 cases, including the
literal #5479/#5480/#5486 shapes).
