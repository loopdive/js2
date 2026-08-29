---
id: 5181
title: "#5204's selfhost commit shifted 2,580 standalone failures to the stack-balance shared-body refusal — 24 fell outside every root-cause bucket and blocked the merge queue"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: critical
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


---

# Measurement — 2026-08-29: the standalone pass drop behind the stack-balance shift

**Verdict: CONFIRMED regression, and it is bigger than the stack-balance
signature alone.** `8f161cbf15` did not merely relabel existing failures. Of 25
sampled tests carrying the stack-balance signature that the CI baseline records
as `pass`, **21 flipped `pass` -> `compile_error`** when measured directly
against the commit's own parent. A second, independent sample shows the same
commit **also** turns 17 of 25 previously-passing tests into wrong-answer
`fail`s that carry no stack-balance signature at all.

Priority raised `high` -> `critical` on this evidence.

## 1. What the floor gate reported

Required step **"Standalone pass-count high-water floor (#2097)"**, merge_group
run [33237529607](https://github.com/loopdive/js2/actions/runs/33237529607/job/99062743545)
(group `pr-5220`, head `854045e499`, 2026-08-29T06:19:41Z):

```
[standalone-highwater] current pass=31371, mark=33644 (floor=33594, tolerance=50, delta=-2273).
```

| field | value |
| --- | --- |
| measured `full_summary.host_free_pass` | **31,371** |
| committed high-water mark | **33,644** |
| floor (mark - tolerance 50) | **33,594** |
| **delta vs mark** | **-2,273** |
| mark set at | `eafe7d1d2360aadbc87f0b5f9cb15a0cf59aa663`, 2026-08-28T20:27:01Z |

The metric is `host_free_pass`, not raw `pass` — so the #2879 §4 carrier-migration
excuse ("a mid-flight carrier PR legitimately dips raw `pass`") does **not**
apply. In both datasets used below `host_free_pass == pass` exactly, so the two
numbers are interchangeable here.

**The breach does not predate `8f161cbf15`.** Three independent pre-#5204 data
points:

- The high-water mark itself — 33,644 — was set by a *passing* run at
  `eafe7d1d23` (2026-08-28T20:27:01Z), before #5204 landed (`523bd0428b`,
  2026-08-29T01:31:14Z). The mark only ratchets up, so pass was >= 33,644 there.
- The last full `merge_group` run before #5204 landed
  ([33216463947](https://github.com/loopdive/js2/actions/runs/33216463947),
  head `e1335c2d3b`, 2026-08-28T22:21-22:41Z) concluded **success**, and the
  floor step is a required step inside that run's `merge shard reports` job.
- The promoted standalone baseline JSONL (below) sits at 33,876 pass, comfortably
  above the floor, and contains **zero** rows carrying the stack-balance signature.

The floor breach only became *visible* in the `pr-5220` group because #5220's
root-cause bucket is what lets the pipeline get past the earlier
`--max-unclassified-root-causes 0` gate and actually reach the floor step. Every
full merge_group run between #5204 landing and #5220 died at the unclassified
gate first.

## 2. Datasets

| name | what it is |
| --- | --- |
| **CI baseline** | `test262-standalone-current.jsonl` from `loopdive/js2wasm-baselines`, fetched `--force` 2026-08-29T06:25Z. 48,735 rows, **33,876 pass**, **0 stack-balance rows**. Row timestamps 04:07:19-04:24:09 (runner local, UTC+2) => a promote-baseline run at ~02:07-02:24Z. |
| **merge-group report** | artifact `test262-merged-report` id 9710548199 of run 33237529607. 48,735 rows, **31,371 pass**, **2,580 stack-balance rows** (all `compile_error`). |
| **local A/B** | `runTest262File(..., "standalone")` on two checked-out trees: child `8f161cbf15` and its first parent `70e8e3c1ca`. Same `test262` submodule pointer (`b363f29d3c`) and same lockfile on both — the only `package.json` delta is one added script line, so a single `pnpm install --frozen-lockfile` serves both. |

Baseline -> merge-group transition matrix (changed cells only):

| from | to | n |
| --- | --- | --- |
| fail | compile_error | 1,507 |
| pass | fail | 1,475 |
| pass | compile_error | 1,100 |
| fail | pass | 68 |
| compile_timeout | compile_error | 6 |
| compile_error | pass | 2 |
| compile_error | fail | 1 |
| compile_timeout | fail | 1 |

Gross pass losses **2,575**; net **-2,505**. Of those 2,575, only **750** carry
the stack-balance signature — so the signature was never going to explain the
whole floor drop, and this is why the sample was widened to a second corpus.

## 3. Instrument validation (positive control)

Run first on **both** trees, before any sample:

| tree | `language/statements/if/if-stmt-else-async-gen.js` (expect pass) | `language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-prop-eval-err.js` (expect fail) |
| --- | --- | --- |
| parent `70e8e3c1ca` | pass | fail |
| child `8f161cbf15` | pass | fail |

Both statuses are reachable on both trees, so a uniform result in the samples
below is a property of the trees, not of the harness.

## 4. Corpus A — the stack-balance population

**Sampling frame:** the 2,580 merge-group rows carrying
`stack-balance (#1058)`, restricted to the **750** whose CI-baseline standalone
status is `pass`. Sampled 25, deterministic seed 5181, round-robin across path
families so the TypedArray bulk (416 + 117 + ...) cannot swamp the tail.

All 25 carry the identical diagnostic at the child, e.g.
`stack-balance (#1058): function "__closure_69" reaches an instruction array from
incompatible control-flow or function-local contexts.`

| # | test262 file | CI baseline | parent `70e8e3c1ca` | child `8f161cbf15` | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `built-ins/Array/prototype/reduceRight/callbackfn-resize-arraybuffer.js` | pass | fail | compile_error | fail -> compile_error |
| 2 | `built-ins/Atomics/sub/non-shared-int-views-throws.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 3 | `built-ins/Function/S15.3.5_A3_T2.js` | pass | n/a (env) | compile_error | not locally measurable (eval engine) |
| 4 | `built-ins/Function/prototype/bind/15.3.4.5.2-4-5.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 5 | `built-ins/Promise/create-resolving-functions-resolve.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 6 | `built-ins/Promise/prototype/finally/resolved-observable-then-calls-argument.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 7 | `built-ins/TypedArray/from/mapfn-is-not-callable.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 8 | `built-ins/TypedArray/of/this-is-not-constructor.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 9 | `built-ins/TypedArray/prototype/fill/return-abrupt-from-end.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 10 | `built-ins/TypedArrayConstructors/Float32Array/proto.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 11 | `built-ins/TypedArrayConstructors/Float64Array/is-a-constructor.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 12 | `built-ins/TypedArrayConstructors/Int16Array/proto.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 13 | `built-ins/TypedArrayConstructors/Int32Array/is-a-constructor.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 14 | `built-ins/TypedArrayConstructors/Uint16Array/proto.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 15 | `built-ins/TypedArrayConstructors/Uint32Array/is-a-constructor.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 16 | `built-ins/TypedArrayConstructors/Uint8Array/proto.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 17 | `built-ins/TypedArrayConstructors/Uint8ClampedArray/proto.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 18 | `built-ins/TypedArrayConstructors/ctors-bigint/length-arg/undefined-newtarget-throws.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 19 | `built-ins/TypedArrayConstructors/ctors/buffer-arg/new-instance-extensibility.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 20 | `built-ins/TypedArrayConstructors/from/BigInt/iter-next-error.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 21 | `built-ins/TypedArrayConstructors/internals/Delete/BigInt/detached-buffer-key-is-symbol.js` | pass | n/a (env) | compile_error | not locally measurable (eval engine) |
| 22 | `built-ins/TypedArrayConstructors/of/custom-ctor-returns-smaller-instance-throws.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 23 | `built-ins/TypedArrayConstructors/prototype/Symbol.iterator.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 24 | `harness/deepEqual-array.js` | pass | pass | compile_error | **REGRESSION** pass -> compile_error |
| 25 | `language/expressions/instanceof/S15.3.5.3_A2_T5.js` | pass | n/a (env) | compile_error | not locally measurable (eval engine) |

**Corpus A result: 21 of 25 are confirmed `pass` -> `compile_error` regressions.**

The 4 non-regressions are not counter-evidence of a relabel; they split as:

- **3 not locally measurable** (`Function/S15.3.5_A3_T2`,
  `TypedArrayConstructors/internals/Delete/BigInt/detached-buffer-key-is-symbol`,
  `instanceof/S15.3.5.3_A2_T5`) — they need the QuickJS eval-engine provider,
  which is not built in this container
  (`JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built`). They
  **compile cleanly** at the parent and hard-fail at compile on the child, and CI
  records them as baseline `pass`. Not counted as regressions.
- **1 genuine non-regression**:
  `Array/prototype/reduceRight/callbackfn-resize-arraybuffer.js` really is `fail`
  at the parent locally (a `compareArray` assertion), despite CI baseline `pass`.
  A real local/CI divergence, counted honestly against the flip rate.

So the rate is **21/25 = 84%** of the drawn sample, or **21/22 = 95%** of the
locally measurable ones.

## 5. Corpus B — the non-stack-balance pass losses

The floor delta (-2,273) is far larger than anything the 750-row stack-balance
sub-population can explain, so a second sample was drawn from the **1,825**
pass-losses that carry **no** stack-balance signature — 5 per `error_category`,
seed 51812.

| # | test262 file | CI baseline | parent `70e8e3c1ca` | child `8f161cbf15` | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `built-ins/Array/prototype/concat/create-species-poisoned.js` | pass | fail | fail | no change |
| 2 | `built-ins/Array/prototype/map/create-species-poisoned.js` | pass | fail | fail | no change |
| 3 | `built-ins/Array/prototype/splice/create-species-poisoned.js` | pass | fail | fail | no change |
| 4 | `built-ins/RegExp/match-indices/indices-array-unicode-property-names.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 5 | `built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T10.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 6 | `language/expressions/arrow-function/dstr/dflt-obj-ptrn-prop-ary.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 7 | `language/expressions/arrow-function/dstr/obj-ptrn-id-trailing-comma.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 8 | `language/expressions/assignment/dstr/array-elem-put-obj-literal-prop-ref-init-active.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 9 | `language/expressions/assignment/dstr/array-elem-put-obj-literal-prop-ref.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 10 | `language/expressions/async-generator/named-yield-star-getiter-async-not-callable-object-throw.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 11 | `language/expressions/class/dstr/meth-obj-ptrn-prop-obj.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 12 | `language/expressions/class/elements/static-field-init-this-inside-arrow-function.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 13 | `language/statements/async-generator/dflt-params-ref-prior.js` | pass | pass | pass | no change |
| 14 | `language/statements/async-generator/dstr/ary-ptrn-elem-obj-prop-id-init.js` | pass | pass | pass | no change |
| 15 | `language/statements/class/dstr/async-gen-meth-obj-ptrn-prop-ary.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 16 | `language/statements/class/elements/async-gen-private-method-static/yield-star-next-not-callable-number-throw.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 17 | `language/statements/class/elements/async-gen-private-method/yield-star-getiter-async-returns-string-throw.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 18 | `language/statements/for-await-of/async-func-dstr-var-obj-ptrn-prop-obj-init.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 19 | `language/statements/for-await-of/async-gen-decl-dstr-array-elem-put-unresolvable-strict.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 20 | `language/statements/for-await-of/async-gen-dstr-let-ary-ptrn-elem-id-iter-val.js` | pass | pass | pass | no change |
| 21 | `language/statements/for-await-of/async-gen-dstr-let-obj-ptrn-id-init-fn-name-arrow.js` | pass | pass | pass | no change |
| 22 | `language/statements/for-of/dstr/array-elem-put-obj-literal-prop-ref-init-active.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 23 | `language/statements/for-of/dstr/array-elem-put-obj-literal-prop-ref-init.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 24 | `language/statements/for-of/dstr/array-elem-put-obj-literal-prop-ref.js` | pass | pass | fail | **REGRESSION** pass -> fail |
| 25 | `language/statements/generators/dstr/obj-ptrn-prop-id-init.js` | pass | fail | fail | no change |

**Corpus B result: 17 of 25 are confirmed `pass` -> `fail` regressions at
`8f161cbf15`.** These are *silent wrong answers*, not fail-loud compile errors:

- `arrow-function/dstr/obj-ptrn-id-trailing-comma` — `Expected SameValue(<<null>>, <<23>>)`
- `arrow-function/dstr/dflt-obj-ptrn-prop-ary` — `Expected SameValue(<<0>>, <<7>>)`
- `RegExp/prototype/exec/S15.10.6.2_A4_T10` — `__executed.index` `Expected SameValue(<<2>>, <<null>>)`
- `RegExp/match-indices/indices-array-unicode-property-names` — `TypeError: Cannot access property on null or undefined`

Destructuring binds the wrong value and `RegExp.exec` reports the wrong index.
That is a correctness class strictly worse than the stack-balance refusal, which
at least fails loudly.

The 8 non-regressions split as:

- **4 unchanged `pass` on both trees** (`async-generator/dflt-params-ref-prior`,
  `async-generator/dstr/ary-ptrn-elem-obj-prop-id-init`,
  `for-await-of/async-gen-dstr-let-ary-ptrn-elem-id-iter-val`,
  `for-await-of/async-gen-dstr-let-obj-ptrn-id-init-fn-name-arrow`). Their CI
  `compile_error` is a *different* diagnostic —
  `standalone target emitted host imports: env::__gen_next (#2961)` — i.e. from a
  later commit, **not** from `8f161cbf15`. All 4 are the `host_import_leak`
  category, which is why that category's flip rate is only 1/5.
- **4 `fail` on both trees** (the three `create-species-poisoned` tests and
  `generators/dstr/obj-ptrn-prop-id-init`) — already failing at the parent
  locally despite CI baseline `pass`.

## 6. Extrapolation

Stated with its frame, no false precision. Corpus B is sampled 5-per-category,
not proportionally, so it is re-weighted by real population size:

| population | n | sampled flip rate | est. attributable to `8f161cbf15` |
| --- | --- | --- | --- |
| stack-balance signature, CI baseline `pass` | 750 | 21/25 (21/22 measurable) | **630 - 716** |
| non-stack-balance `assertion_fail` | 876 | 4/5 | 701 |
| non-stack-balance `other` | 621 | 5/5 | 621 |
| non-stack-balance `host_import_leak` | 307 | 1/5 | 61 |
| non-stack-balance `illegal_cast` | 12 | 5/5 | 12 |
| non-stack-balance `type_error` | 9 | 2/5 | 4 |
| **total** | **2,575 gross pass losses** | | **~2,030 - 2,115** |

So roughly **79-82% of the 2,575 gross standalone pass losses trace to
`8f161cbf15`**, against a floor delta of -2,273. Two caveats that keep this
honest:

- Each per-category rate rests on 5 observations (25 for corpus A). The
  category-level figures are indicative; the aggregate is the load-bearing one.
- The remaining ~460-545 losses are **not** attributed here. At least one other
  cause is identified — the `env::__gen_next` host-import leak (#2961) seen on 4
  corpus-B rows that pass on both trees — and it is a *different* commit.

## 7. Still live on current `main`

Spot-check of 8 confirmed regressions (4 from each corpus) re-run on `main` tip
`ddab1b0743`: **8/8 still broken**, identical statuses to `8f161cbf15`
(4 `compile_error`, 4 `fail`). The regression is live right now, not something a
later commit already repaired.

## 8. Reproduction

```bash
git checkout --detach 70e8e3c1ca   # or 8f161cbf15
node --import tsx .tmp/ab-arm.mts .tmp/ab-corpus.json .tmp/out.jsonl parent
```

where `.tmp/ab-arm.mts` calls
`runTest262File(file, category, 60000, "standalone")` per row (the shape of
`scripts/measure/arm.mts`). Corpora are regenerated from the CI baseline JSONL
plus the merge-group artifact; both trees share one `pnpm install`.

## 9. What this does not do

No compiler fix is attempted here — the shared-`Instr[]` producer in the
selfhost-touched path remains unidentified, and that is the follow-up slice
below. This record answers only "were any of them passing", and the answer is
yes, at scale.

---

## Acceptance criteria

- [x] `--max-unclassified-root-causes 0` exits 0 on the real merged standalone
      JSONL, with the 24 claimed and no other bucket's count changed.
- [x] The sample A/B against `70e8e3c1ca` is run and its result recorded here —
      **21/25 stack-balance-signature rows and 17/25 non-signature rows regressed
      from `pass`** (2026-08-29 measurement below).
- [ ] The producer that shares one `Instr[]` across closure owners is named.
- [ ] Decide revert-or-fix for `8f161cbf15` / #5204 — the floor stays breached
      and the merge queue stays red until one of them happens.
