---
id: 1609
title: "codegen: non-literal spread argument in new-expression not supported"
status: in_progress
created: 2026-05-24
updated: 2026-08-27
priority: high
feasibility: hard
assignee: ttraenkler/codex-es6-new-spread
task_type: feature
area: codegen
language_feature: spread, new-expression
goal: compiler-correctness
sprint: Backlog
related: [1320, 1620, 1633]
es_edition: es2015
test262_count: 14
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/iterator-native.ts
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  - src/codegen/iterator-native.ts::buildIteratorBody
  - src/codegen/expressions/new-super.ts::compileNewFunctionExpression
  - src/codegen/statements/nested-declarations.ts::emitSetExtrasArgv
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
---
# #1609 — Non-literal spread in `new` expression unsupported

## Problem

Historically, 18 test262 tests failed with:

```
new FunctionExpression with non-literal spread not supported
```

Those historical rows were `language/expressions/new` spread tests where the constructor is
invoked with `new F(...iterable)` and the spread operand is a non-array-literal
(an iterator, a variable, an expression that throws mid-iteration).

The exact maintained ES2015 census below is now the source of truth; it contains
14 current paths (the old 18-row count included paths no longer present in the
edition-filtered checkout).

## Failing test examples

- `test/language/expressions/new/spread-sngl-expr.js`
- `test/language/expressions/new/spread-sngl-iter.js`
- `test/language/expressions/new/spread-err-sngl-err-itr-step.js`

## Root-cause hypothesis

Spread-in-`new` codegen only handles the array-literal fast path
(`new F(...[a, b])`) and bails on the general iterator-protocol spread. The
call-expression path already supports general spread; the `new`-expression
path in `src/codegen/expressions.ts` needs the same iterator-protocol
expansion (build the argument array from the iterator, then apply to the
constructor). Reuse the existing call-spread lowering for the construct path.

## Acceptance criteria

- `new F(...iter)` with a non-literal iterable compiles.
- >=14 of the 18 tests move off `compile_error`.

## Investigation 2026-05-27 (dev-1604) — root-cause hypothesis is wrong; BLOCKED on iterator bridge

The "reuse call-expression spread lowering" hypothesis underestimates the work.
Findings from inspecting the actual failing test262 files
(`language/expressions/new/spread-*`):

1. **Every** failing test invokes an anonymous `new function() { ... }` with
   **no formal parameters** and reads `arguments.length` / `arguments[i]`.
   So there is no formal-param subset to expand a spread into — the spread
   result must populate a **dynamic-length `arguments` object**.
   `compileNewFunctionExpression` (src/codegen/expressions/new-super.ts:854)
   builds a *static* `arguments` vec from a **compile-time-fixed** formal/flat
   arg count (lines 1064-1078). A runtime-variable spread length breaks that
   assumption outright.

2. The non-literal sources are custom `Symbol.iterator` objects
   (`spread-sngl-iter`, `spread-mult-iter`) and assignment expressions / vars
   holding plain arrays (`spread-sngl-expr` = `...(target = source)`), plus a
   block of error tests (`spread-err-*-itr-step/value/get-*`) that require
   driving an arbitrary iterator and propagating a **mid-iteration throw**.

3. `compileSpreadCallArgs` (src/codegen/expressions/extern.ts:404) — the
   lowering the issue suggested reusing — only expands a **vec-struct
   (compiled-array) source into a fixed param count**. It does NOT drive a
   general `Symbol.iterator`. Confirmed: even the *plain call* path emits
   invalid Wasm for `f(...customIterObj)` ("not enough arguments on the stack").
   Only a typed-array variable (`number[]`) spread compiles to valid Wasm today.

**Conclusion**: #1609 needs (a) a runtime iterator-protocol driver producing a
dynamic-length argv, and (b) a dynamic-argv lifted constructor to build
`arguments`. That is the **same iterator-bridge infrastructure as #1620 /
#1633** (the latter escalated NEEDS-SPEC for exactly this). This issue is
**blocked on #1620 / #1633**, not a localized dev fix. Re-route after the
iterator bridge lands; reassess then whether the array-literal/typed-array
subset can be carved off as a partial win.

## Resume plan — 2026-08-27

The old dependency state is stale: #1620 and #1320 are now complete, and the
compiler has since gained native iterator/generator and dynamic call-boundary
infrastructure. #1633 still tracks broader `Array.from`/`Array.of` constructor
semantics, but it is no longer accepted as proof that these 18 `new` spread
rows remain structurally blocked. This checkpoint reopens #1609 for a bounded,
verify-first implementation attempt.

1. Rebuild the exact current ES2015 `language/expressions/new/spread-*` cohort
   from the maintained 11,704-path edition filter. Run every candidate alone
   in standalone and host modes with the pinned Test262 checkout, QuickJS
   artifact, LLVM 18, and at most two compiler workers; record exact statuses
   and signatures rather than carrying forward the historical count.
2. Partition the cohort into compiled-array/typed-array operands, arbitrary
   custom iterables, multiple spreads, and iterator abrupt-completion cases.
   Confirm whether the current ordinary-call spread and iterator drivers can
   produce a runtime argv carrier that constructor lowering can consume.
3. Select the largest cohesive host-pass cluster with a shared constructor
   call-boundary root cause. Implement dynamic argument collection once in
   shared construction machinery; preserve evaluation order, `this`/prototype
   construction, dynamic `arguments`, IteratorClose, and abrupt completion.
4. Add focused host/standalone controls for zero/one/multiple spread operands,
   mixed fixed and spread arguments, a custom iterable, `arguments.length` and
   indexed reads, constructor identity, iterator throws, and an adjacent
   already-passing literal-spread case.
5. Rerun the exact selected slice and complete candidate cohort in both lanes,
   mandatory repository gates, and a same-base pass-to-nonpass comparison.
   Record artifacts, counts, residual ownership, commit SHA, and handoff here.

### Acceptance

- The current candidate denominator and both-lane baseline are exact.
- The selected cohesive cluster reaches 100% standalone and host pass with
  zero failures, compile errors, timeouts, or skips and no pass regression.
- The implementation contains no fixture rewrites, runner exemptions, host
  oracle shortcuts, or forced array-only semantics for arbitrary iterables.
- The upstream PR uses the repository Description/CLA template and stays draft
  until the scoped fix is complete, current-main based, CI-green, and mergeable.

## Verification checkpoint — 2026-08-27

### Exact census and pinned setup

The maintained edition index is
`website/public/benchmarks/results/test262-file-editions.json` (sha256
`492cf9f4c610f944c5d5946e1f6ba7aea59e8f99b264c25ab38c019694b68a91`). Filtering
`files` for edition index `2` (`ES2015`) gives 11,778 paths; excluding 74
`intl402` paths leaves the exact maintained denominator of 11,704. Filtering
that index for `language/expressions/new/spread-*` gives 14 existing paths and
no missing paths. The exact candidate list is captured at
`/private/tmp/js2-1609-es2015-spread-paths.txt` (sha256
`c04f97f743d5a660fd599cadb453e7dfa8778a80c9ae699c8da24cec315559c9`, 14
lines).

Both lanes used the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda/libquickjs.wasm` (sha256
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`), the
LLVM 18 toolchain, and the fixed repository PATH. The final compiler bundle
sha256 is `778030a1aab2beb287f1e395ec9d7a602fc059577ef5ae7297627446702c7131`;
the final standalone provider is the pinned-artifact adapter cache entry
`quickjs-eval-adapter-b75ba554a3f6ff49.wasm` (bundle key
`778030a1aab2bebd`, QuickJS artifact key `2e2d7736713beeda`).

### Fresh two-lane results

The pre-change same-base commit was `d232d6dfd34d7c0238f77871e2f0d47f881124a9`.
Authentic assembled-harness runs used structural pass/fail controls and a
120,000 ms per-file timeout. Before the fix, both lanes reported exactly
`{"fail":14}`: the two valid iterator rows observed zero constructor
arguments, while the 12 abrupt-completion rows observed no expected throw
(including the two TypeError rows for a null iterator result/property).

After the fix, the complete 14-path cohort reported `{"pass":14}` in both
host and standalone lanes, with no compile errors, timeouts, or skips. Each
row was run twice; both lanes reported `nondeterministic: 0`. The local A/B
partition was verified independently for each lane: 14 fail→pass, 0 pass→fail,
0 other changes, 0 unchanged, union 14.

The raw final result artifacts are `/private/tmp/js2-1609-host-final.jsonl`
(sha256 `59890cece6993e2392c658f1475ecdc0ddf42fe6395989636b62fa1b4874f088`)
and `/private/tmp/js2-1609-standalone-final.jsonl` (sha256
`2ae861807d121c26e71a1336110b69930fd68c8903b2fab3d842ee68e73e52c3`). The
same-base before artifacts are `/private/tmp/js2-1609-host-before.jsonl`
(sha256 `23efacb214a9c2b47d1064db2c0ed598d172f998dd4b5d53e824aba86789919d`)
and `/private/tmp/js2-1609-standalone-before.jsonl` (sha256
`9c56db7098bcea28292d4a03dbaa196c2c181aa634de52bec8abd3fc8f35a6cb`).

### Current-main reconciliation and final scoped rerun

The branch was reconciled with fetched `upstream/main` at
`95eec5404a384a0565bf0abb9cda1a93a413e2cf` (merge commit
`8e4e68203f9feb9e6e3701459d8025dedac2a5bf`). The post-merge compiler bundle
sha256 is `100a3368b0b43637b3057813ae9b38a7e31da85a5fca4ec94a703648425a6354`;
the standalone provider is
`.test262-cache/quickjs-eval-adapter-4ea4451a6433d336.wasm` (sha256
`f3d9e8ee112dc1e041fa19ca9890809adbc10289e739d27917d6ed00e10819de`, bundle
key `100a3368b0b43637`, QuickJS artifact key `2e2d7736713beeda`). The exact
post-merge host artifact
`/private/tmp/js2-1609-host-postmerge.jsonl` has sha256
`59890cece6993e2392c658f1475ecdc0ddf42fe6395989636b62fa1b4874f088`; the
standalone artifact `/private/tmp/js2-1609-standalone-postmerge.jsonl` has
sha256 `2ae861807d121c26e71a1336110b69930fd68c8903b2fab3d842ee68e73e52c3`.
Both post-merge runs remain `{"pass":14}` with 14/14 rows, no compile errors,
timeouts, skips, or nondeterminism. Comparing each post-merge lane against
the same-base before artifact independently verifies 14 fail→pass, 0
pass→fail, 0 other, and 0 unchanged.

### Root cause and implementation

The current constructor lowering had a static-only assumption: when the
anonymous function expression had no formal parameters, it synthesized one
fixed f64 parameter per compile-time-flattened argument. A non-literal spread
could not provide that arity, so codegen reported
`new FunctionExpression with non-literal spread not supported`; even the
existing shared extras builder counted a spread source as one slot instead of
expanding its iterator values.

The fix keeps the shared constructor boundary and adds one dynamic lane:

- `compileNewFunctionExpression` leaves the lifted anonymous constructor
  zero-arity for a dynamic spread, publishes `__extras_argv` plus `__argc`, and
  builds its `arguments` vector through the same `emitArgumentsVecBody` path
  used by ordinary calls.
- `emitSetExtrasArgv` evaluates fixed and spread operands once in source order,
  expands vector/tuple carriers directly, uses the strict host iterator import
  in the host lane, and uses native `__array_from_iter_n(source, -1)` plus
  native indexed readers in standalone. The native call's `-1` bound denotes
  the unbounded ArgumentListEvaluation drain.
- The native iterator object arm now checks `__extern_has` so a present but
  null/undefined `@@iterator` is not mistaken for a missing method; a callable
  `@@iterator` returning null likewise raises the catchable TypeError required
  by §7.4.1. Bare `{next(){…}}` iterator fallback remains available.

No fixture rewrites, runner exemptions, host-oracle shortcuts, or forced
array-only semantics were used. Focused coverage is in
`tests/issue-1609-new-expression-spread.test.ts`: 8 tests (host and standalone)
cover one custom iterable, mixed fixed/multiple spreads, dynamic
`arguments.length` and indexed reads, constructor identity, abrupt iterator
steps, and the adjacent literal-spread control.

### Gates, residuals, and handoff

Passed gates on this checkpoint: TypeScript 5 and TypeScript 7 typechecks,
Biome lint, Prettier check, `git diff --check`, issue-index consistency,
the focused 8-test suite, and the pinned exact 14-path two-lane harness
(including determinism and A/B partition checks), both before and after
current-main reconciliation. The implementation checkpoint is commit
`74aad2b0cdfe64cdf88cad85b9920debb416e654`; the current-main reconciliation
is commit `8e4e68203f9feb9e6e3701459d8025dedac2a5bf`.

The scoped ES2015 cohort is complete. Dynamic spreads on a function expression
with declared formal parameters still retain the existing diagnostic because
they are outside this zero-formal cohort; WASI remains outside this host /
standalone slice and keeps its prior best-effort route. Those are explicit
follow-ups, not hidden residual failures. After the final pushed head
`ee9b3927797069da0e121cf8c7fc295198cd96eb`, GitHub reports 25 successful and
11 expected skipped checks, zero pending/failures, and `MERGEABLE`; PR #5048 is
ready for review. Ownership handoff: `ttraenkler/codex-es6-new-spread`,
implementation owner `ttraenkler/codex-es6-new-spread`, with the exact
artifacts and residual follow-ups recorded in this checkpoint.

### Repaired-main landing handoff — 2026-08-27

PR #5048 was deliberately dequeued after its merge-group run inherited the
145-row standalone regression signature `c12d78255ab4839c` from merged PR
#5044. That regression was repaired by PR #5057 and its merge-group Test262
regression guard passed before this branch was synchronized again.

The branch now includes repaired `upstream/main` merge commit
`12805b623fe623178245ffaef8bfae0a860edb41` through synchronization checkpoint
`40940671f`. A fresh exact rerun after that merge remains **14/14 pass** in the
host lane and **14/14 pass** in standalone, with zero failures, compile errors,
timeouts, or skips. The artifacts are
`/private/tmp/js2-1609-host-repairmerge.jsonl` (sha256
`59890cece6993e2392c658f1475ecdc0ddf42fe6395989636b62fa1b4874f088`) and
`/private/tmp/js2-1609-standalone-repairmerge.jsonl` (sha256
`2ae861807d121c26e71a1336110b69930fd68c8903b2fab3d842ee68e73e52c3`).

Landing procedure: push this evidence checkpoint, remove the temporary
`hold` label, and re-enter the merge queue. Do not bypass a failed queued
regression guard.
