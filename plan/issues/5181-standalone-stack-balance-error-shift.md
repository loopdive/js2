---
id: 5181
title: "#5204's selfhost commit shifted 2,580 standalone failures to the stack-balance shared-body refusal — 24 fell outside every root-cause bucket and blocked the merge queue"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
task_type: bugfix
area: codegen
goal: ir-full-coverage
related: [1058]
---

# What happened

Every `merge_group` re-validation was failing the required **`merge shard reports`**
check at its `Build merged standalone test262 report` step:

```
Standalone root-cause map has 24 unclassified failures; threshold is 0.
```

That is `scripts/build-test262-report.mjs --target standalone
--max-unclassified-root-causes 0`. The gate is a hard zero, so 24 rows nobody
had a bucket for wedged the queue for every open code PR (#5211, #5214, #5217,
#5218 queued behind it).

## The failures are all one signature

All 24 are `status: compile_error`, `error_category: "other"`, carrying exactly
one diagnostic — `src/codegen/stack-balance.ts:2804`:

> `stack-balance (#1058): function "…" reaches an instruction array from
> incompatible control-flow or function-local contexts. The repair pass refuses
> to mutate one shared body for all owners; emit distinct instruction arrays at
> the producer.`

In plain terms: two callers that need *different* stack repairs end up pointing
at the **same** `Instr[]` array, so the repair pass cannot fix one without
breaking the other, and it refuses rather than guess. It is a fail-loud, not a
silent miscompile.

That diagnostic entered `main` with commit **`8f161cbf15`** — *"feat(selfhost):
compile TypeScript 5 parser graph to Wasm"*, landed via **PR #5204** (a PR
number, not a plan-issue id; parent commit `70e8e3c1ca`). `git log -S 'refuses
to mutate' -- src/codegen/stack-balance.ts` returns that one commit.

## The measured split — 2,580 rows, 24 orphans

Measured directly on the merged standalone JSONL from the parked run
(`test262-merged-report` artifact 9709198482 of run 33232469498, merge sha
`7e0dbb303e`, 48,735 rows):

| population | count |
| --- | --- |
| standalone rows carrying the signature | **2,580** (all `compile_error`) |
| …already claimed by an existing feature-path bucket | 2,556 |
| …matching no bucket at all → `unclassified` | **24** |

The 2,556 are claimed by path: a leaked `env::__temporal_*` import on a Temporal
test still lands in `temporal-proposal`, a RegExp test in the RegExp buckets, and
so on. The 24 orphans are the tests whose *path* no bucket names:

| family | n |
| --- | --- |
| `test/built-ins/Error/prototype/stack/*` | 14 |
| `test/harness/deepEqual-*` | 5 |
| `test/harness/testTypedArray*` | 3 |
| `test/language/expressions/instanceof/*` | 2 |

Full list: `getter-error-as-prototype`, `getter-error-instance`,
`getter-error-prototype`, `getter-subclass`, `instance-no-own-stack`,
`instance-not-enumerable`, `setter-empty-string`, `setter-no-argument`,
`setter-non-extensible-receiver`, `setter-non-string-value`,
`setter-non-writable-stack`, `setter-own-accessor`,
`setter-receiver-is-other-prototype`, `setter-via-assignment` (all under
`built-ins/Error/prototype/stack/`); `deepEqual-array`, `deepEqual-circular`,
`deepEqual-deep`, `deepEqual-mapset`, `deepEqual-primitives`;
`testTypedArray`, `testTypedArray-conversions`,
`testTypedArray-conversions-call-error`; `instanceof/S15.3.5.3_A2_T5`,
`instanceof/S15.3.5.3_A3_T1`.

## What this PR ships (the unblock only)

One new **error-signature** bucket in `STANDALONE_ROOT_CAUSE_BUCKETS`
(`scripts/build-test262-report.mjs`), `id: stack-balance-shared-body`, matching
the two spellings of the one signature — the raw `error` keeps the literal
`(#1058)` while `error_signature` digit-normalises it to `(##)`.

It is placed **with the residual catches near the end of the list**, not at the
top, deliberately: `find`'s first match wins, so a top placement would pull all
2,556 already-classified rows out of their feature buckets. The bucket therefore
claims exactly the 24 orphans and nothing else — verified by diffing every
bucket count before and after against the real merged JSONL:

```
BEFORE unclassified: 24    AFTER unclassified: 0
BEFORE classified: 17226   AFTER classified: 17250  (of 17250)
BUCKET DELTA stack-balance-shared-body 0 -> 24
no other bucket changed count — zero poaching
exit 0
```

`tests/issue-5181-stack-balance-root-cause.test.ts` pins all three facts:
unclassified is 0, the bucket claims the residual, and a same-signature row on a
feature path stays in its feature bucket.

**This is classification, not a fix.** Nothing about the compiler changed; the
24 tests still fail. It restores the merge queue and makes the failure visible
under a name that says what it is.

# The real follow-up

## 1. Does the error-mode shift hide genuine regressions?

`8f161cbf15` moved 2,580 standalone rows onto this signature. Unknown, and the
question that matters: **were any of those 2,580 passing before it?** A row that
went `pass → compile_error` is a regression that the root-cause map now files
tidily under a known bucket, which is exactly how a real loss stays invisible.

Spot-check protocol:

1. Sample 20 of the 2,580 from the merged report (stratify: some from each of
   the large feature buckets, not just the tail).
2. A/B against `8f161cbf15^` = `70e8e3c1ca`, standalone target, same runner
   flags. Use the file-copy pattern from `CLAUDE.md`, and capture the base copy
   **before** the first edit.
3. Any `pass` at the parent that is `compile_error` at `8f161cbf15` is a
   regression — count it, then widen the sample toward that family.
4. Cross-check against the per-SHA baseline diff for the `8f161cbf15` merge if
   one survives; a `pass → compile_error` transition should have shown there.

If the answer is "none were passing", this is a pure error-mode relabel and the
bucket is the right permanent home. If any were, the shift is a regression that
needs its own issue and a revert-or-fix decision.

## 2. Root-cause the shared-body refusal for the `Error.prototype.stack` family

The 24 orphans are not random — 14 of them are one feature (`Error.prototype.
stack` getter/setter) and 8 more are two harness helpers (`deepEqual`,
`testTypedArray`). Both shapes are *accessor-heavy closure code*: the reported
function names are `__closure_NN`, `makeNativeError`, `cacheComparison`,
`formatSimpleValue`. That is a strong hint the shared-`Instr[]` aliasing comes
from one producer emitting a single body for several closure owners.

Find that producer and give each owner its own array (that is literally what the
diagnostic asks for: "emit distinct instruction arrays at the producer"). Fixing
it should retire the 24 and take a slice of the 2,556 with it.

## Acceptance criteria

- [x] `--max-unclassified-root-causes 0` exits 0 on the real merged standalone
      JSONL, with the 24 claimed and no other bucket's count changed.
- [ ] The 20-sample A/B against `70e8e3c1ca` is run and its result recorded here
      — including "zero regressions found", which is a result, not a non-answer.
- [ ] The producer that shares one `Instr[]` across closure owners is named.
