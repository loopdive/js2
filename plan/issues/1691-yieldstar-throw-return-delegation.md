---
id: 1691
title: "yield* does not delegate throw()/return() to the inner iterator (eager-generator model gap)"
status: in_progress
sprint: Backlog
created: 2026-05-27
updated: 2026-08-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
parent: 1665
assignee: ttraenkler/codex-es6-yieldstar-throw
related: [1042, 1665, 2170, 2173, 3711]
loc-budget-allow:
  - src/codegen/generators-native.ts
  - src/codegen/iterator-native.ts
  - src/codegen/registry/imports.ts
  - src/runtime.ts
  - src/codegen/object-ops.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - src/codegen/generators-native.ts::compileState
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/runtime.ts::resolveImport
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
---
# #1691 — yield* does not delegate throw()/return() to the inner iterator

## Problem

`yield* <iterable>` correctly forwards `next()` values but does **not** forward
the outer generator's `throw()` / `return()` into the delegated iterator, as
required by ECMAScript §14.4.14 (YieldExpression : `yield * AssignmentExpression`,
the `received.[[Type]] is throw` / `is return` branches).

13 test262 cases in `language/expressions/yield` fail on this — the entire
`star-rhs-iter-thrw-*` family plus `star-rhs-iter-thrw-violation-*`:

- `star-rhs-iter-thrw-thrw-invoke.js` — asserts the delegate's `throw` method
  is invoked with the thrown value; compiler returns wrong sentinel (observed 7777).
- `star-rhs-iter-thrw-res-value-final.js` — observed 2222 instead of delegated value.
- `star-rhs-iter-thrw-res-done-err.js`, `-res-done-no-value.js`,
  `-res-value-err.js`, `-thrw-call-err.js`, `-thrw-call-non-obj.js`,
  `-thrw-get-err.js`, `-violation-no-rtrn.js`, `-violation-rtrn-call-err.js`,
  `-violation-rtrn-call-non-obj.js`, `-violation-rtrn-get-err.js`,
  `-violation-rtrn-invoke.js`.

The sibling `return()` delegation (`star-rhs-iter-rtrn-*`) compiles but does not
exercise true lazy delegation either; it currently passes only because the eager
model happens to drain to completion for the simple shapes.

## Root cause

The compiler uses an **eager generator model**. `compileYieldExpression`
(`src/codegen/expressions/misc.ts:177`, the `expr.asteriskToken` branch) lowers
`yield* x` to a call to `__gen_yield_star(buffer, iterable)`.

`__gen_yield_star` (`src/runtime.ts:5692`) is:

```js
(buf, iterable) => {
  if (iterable != null && typeof iterable[Symbol.iterator] === "function") {
    for (const v of iterable) { buf.push(v); }   // next() only
  }
};
```

It drains the inner iterator via a plain `for...of` (calling **only** `next()`)
and pushes every value into the outer generator's buffer eagerly. By the time
user code calls `outerGen.throw(e)` or `outerGen.return(v)`, the inner iterator
has already been fully consumed and discarded — there is no live delegate to
forward the completion to. So the §14.4.14 step-5.b (`throw`) and step-5.c
(`return`) branches are unobservable.

## Why this is hard (feasibility: hard)

Correct `yield*` throw/return delegation requires the generator to **suspend**
at the `yield*` point holding a reference to the live inner iterator, so a later
`throw()`/`return()` on the outer generator can be routed to the delegate's
corresponding method. That is exactly the lazy / re-entrant generator semantics
the eager-buffer model was designed to avoid.

This should be folded into the lazy-generator / CPS work, not patched in the
eager runtime:
- #1665 (native generators — shared `$Iterator` design gap)
- #1373 / #1042 (IR async + CPS lowering — the suspend/resume machinery)

A localized patch to `__gen_yield_star` cannot satisfy the protocol because the
suspension point does not exist in the eager model.

## Acceptance criteria

- `yield*` suspends at the delegation point and forwards `throw()`/`return()` to
  the inner iterator per §14.4.14 steps 5.b / 5.c.
- The 13 `star-rhs-iter-thrw-*` test262 cases pass.
- `star-rhs-iter-rtrn-*` continue to pass under the lazy model.

## Investigation notes (2026-05-27)

Probe of all 63 `language/expressions/yield` tests (proper host imports via
`buildImports` + `wrapTest`): 45 PASS + 3 PASS(negative-CE) = 48 passing; 13
fail on the throw-delegation gap above; 2 are TS-strictness CE artifacts in the
test source (`star-return-is-null.js`, `star-rhs-iter-rtrn-rtrn-invoke.js` —
`'this' implicitly has type 'any'` / iterator-shape typing, not genuine JS parse
failures — out of scope for this issue).

## Related

- Blocks-on: #1665, #1373, #1042 (lazy/CPS generator model)
- Sibling investigation: #820c (async-gen object-method yield* null deref)

## Re-investigation 2026-05-28 (senior-developer)

Re-walked the eager-buffer model to confirm whether anything has shifted that
would unlock a localized fix. Conclusion: **architectural block confirmed,
no hybrid path is feasible without the lazy/CPS generator lowering.**

### Code-path walk (current main)

1. `compileYieldExpression` (`src/codegen/expressions/misc.ts:177`) emits
   `__gen_yield_star(buf, iterable)` synchronously inside the generator body.
2. `__gen_yield_star` (`src/runtime.ts:6544`) is a single closure:
   `for (const v of iterable) buf.push(v)`. It runs to completion at the
   `yield*` call site. Only `iterable[Symbol.iterator]().next()` is touched —
   `throw`/`return` are never even *looked up*, let alone retained.
3. By the time `__create_generator` (`src/runtime.ts:6556`) wraps `buf` and
   returns the generator object, the inner iterator has been fully consumed
   and dropped. There is no reference to it on the state record
   (`_GeneratorState` at `src/runtime.ts:71` stores only `{buf, index,
   pendingThrow}`).
4. `Generator.prototype.throw` (`src/runtime.ts:216`) does
   `state.index = state.buf.length; throw e` — there is no delegate slot to
   route into, because the suspension point does not exist.

### Why a "remember the delegate" patch doesn't work

To forward `outer.throw(e)` per §14.4.14 step 5.b.ii, the outer generator
body must pause **mid-iteration** at the `yield*` site holding a live
reference to the inner iterator. Adding a `delegate` slot to the state
record is not enough: the generator body would still have to *resume after
the throw was forwarded*, drain remaining inner values into the outer
buffer (or propagate IteratorClose), and continue with the next outer
statement. That resume-after-yield* requires a continuation / state
machine for the outer body — which is exactly what the eager model
deliberately omitted. Once `g()` returns, the outer body is gone; there is
no way to "go back" to it.

A partial workaround (`__gen_yield_star` calls `.throw` on the inner
iterator *during the eager drain* if some future `pendingThrow` flag is
set) would require either reading the future state (impossible — the
drain happens before `g()` returns the generator) or making `next()`
itself the driver of the inner drain, one step at a time — which **is**
the lazy generator model (#1665).

### Concrete failure mode

```ts
function* inner() { yield 11; yield 22; yield 33; }
function* outer() { yield* inner(); }
const it = outer();
it.next();          // → {value: 11, done: false}     (spec)
                    //   actually returns same in eager model because inner
                    //   is finite, but inner is *already gone* at this point
it.throw("BOOM");   // spec: looks up inner.throw, calls it, observes
                    //   IteratorClose or rethrow
                    // eager: state.index = buf.length; throw "BOOM"
                    //   (inner never sees the throw — it was discarded)
```

For the test262 spy-iterator pattern (`star-rhs-iter-thrw-thrw-invoke.js`),
the spy's `next()` returns `{done: false}` indefinitely, so the eager
drain at the `yield*` site loops until `__EAGER_GEN_LIMIT = 1_000_000`
fires a RangeError — `g()` never returns the generator instance to call
`.throw()` on at all. This is observable today as one of the
`star-rhs-iter-thrw-*` failures returning `RangeError` instead of the
spec-required behavior.

### Why this can't be carved into a slice

The `pendingThrow` field on `_GeneratorState` already exists (added for
synchronous-throw-in-body capture, #1516). One might hope to wire
`__gen_yield_star` to consult it. But `pendingThrow` is set by the
generator body itself when a host-side throw is captured for re-throw on
the next `.next()` — it is not a channel the outer caller can write to,
because the body has already finished by the time the caller sees `iter`.

There is no path that leaves the buffer model intact and satisfies even
one of the 13 `star-rhs-iter-thrw-*` cases. The fix is the move to
generator suspension, owned by #1665 (native generators) + #1042/#1373b
(CPS lowering for the suspend/resume machinery).

### Recommendation

Keep this issue `blocked` on #1665 and #1042. Do **not** spawn another
dev on it. When #1665 lands, this issue's acceptance criteria are
covered by the same lazy-iterator state machine that implements `next()`
properly — `throw`/`return` delegation is a few additional dispatch
arms on the state record's resume handler, not a separate workstream.

## Resume implementation plan — 2026-08-27

The recorded architectural prerequisites are now complete: #1665 and #1042
are `done`, native suspend/resume generators ship in both relevant compiler
paths, and #2170/#2173 implemented native `yield*` delegation for generator
and general iterable subjects. The old “do not spawn” handoff is therefore
stale. Current ES2015 standalone results still contain 13 members of the
`star-rhs-iter-thrw-*` / `star-rhs-iter-thrw-violation-*` family under the
shared complex-native-generator diagnostic, so this issue is reopened for a
bounded protocol-completion slice.

1. Rebuild the exact current ES2015 throw-delegation cohort from the maintained
   11,704-path edition filter. Run every row alone in standalone and host modes
   with the pinned Test262 checkout, QuickJS artifact, LLVM 18, and at most two
   compiler workers; record exact status/signature and confirm which rows now
   route to native versus buffer lowering.
2. Trace the native `yield*` state graph and resume entry for normal, throw, and
   return completions. Partition missing delegate method, getter/call abrupt,
   non-object result, return fallback, and successful forwarding branches.
   Select the largest cohesive native-lowering cluster; do not fold unrelated
   parser, async-generator, or eager-host residuals into its denominator.
3. Implement the shared §14.4.14 throw-completion arms in the live delegation
   state: forward the received value, validate iterator results, perform the
   required return/close fallback when `throw` is absent, and preserve the
   outer generator's continuation and abrupt completion.
4. Add focused host/standalone controls for successful throw forwarding,
   throwing getter/call, non-callable/non-object results, absent-throw return
   fallback, delegate final values, and adjacent normal/return delegation.
5. Rerun the exact cohort and controls in both lanes, native generator/yield-star
   regression suites, same-base pass-to-nonpass comparison, and mandatory
   gates. Record artifacts, counts, root cause, residual ownership, commit SHA,
   and handoff here.

### Checkpoint evidence — 2026-08-27

The exact candidate list is the 13 sorted files matching
`language/expressions/yield/star-rhs-iter-thrw-` in the pinned Test262 checkout
at `b363f29d3c43c626dc852744ad64a0b48a003693`.

- Host lane, maintained runner `20260827-134605`: **0/13 pass, 13/13 fail**;
  all rows reached execution through the eager/native host helpers. The report
  is `benchmarks/results/test262-report-20260827-134605.json`.
- Standalone lane, maintained runner `20260827-134804`: **0/13 pass,
  13/13 compile_error**. Every row was rejected by the generic `#680`
  complex-native-generator-shape diagnostic before execution. The report is
  `benchmarks/results/test262-standalone-report-20260827-134804.json`.
  Both runs used LLVM 18, two workers, and the pinned QuickJS artifact
  `/private/tmp/js2-quickjs-artifact-2e2d7736713beeda` (sha256 prefix
  `073742801ba76347`).

The first native protocol prototype reached execution after widening the
post-hoc `Symbol.iterator` proof to the enclosing source file. Exact standalone
runner `20260827-145641` measured **1/13 pass, 2/13 assertion failures, and
10/13 wasm_compile failures** (the latter were resume branch-depth validation
errors in `__gen_resume_g`; the two runtime residuals were delegate completion
value/access-order cases). The generated report is
`benchmarks/results/test262-standalone-report-20260827-145641.json`.

The current checkpoint additionally fixes the shared resume branch-depth
calculation and validates the formerly failing `thrw-call-non-obj.js` binary
directly; the exact 13-row regression is intentionally still pending. The
remaining semantic work is to preserve the delegate's non-done result identity
while keeping `IteratorValue` lazy, and to complete the throw/return fallback
and host-lane parity checks.

The bounded exact regression was rerun after the branch-depth and native
IteratorResult validation changes. Maintained runner `20260827-154226` (the
standalone/QuickJS lane) records **7/13 pass, 6/13 assertion failures, 0
compile errors, 0 timeouts, and 0 skips**. Maintained runner `20260827-154404`
(the host/GC lane) records **3/13 pass, 10/13 assertion failures, 0 compile
errors, 0 timeouts, and 0 skips**. Both reports contain exactly the 13 filtered
candidate rows; the empty local shard files are harness noise and are not part
of the denominator. The standalone failures now execute far enough to expose
the remaining semantic cases (primitive result/error propagation, lazy
`value`/getter observation, and return fallback); the host failures remain the
pre-existing native-host parity residuals. The generated reports are
`benchmarks/results/test262-standalone-report-20260827-154226.json` and
`benchmarks/results/test262-report-20260827-154404.json`.

The next bounded checkpoint (2026-08-27, after the shared value/getter/return
seam changes) used the same pinned 13-row list and the maintained assembled
harness in both lanes. Host is now **13/13 pass, 0 assertion failures, 0
compile errors, 0 timeouts, and 0 skips**; the local JSONL is
`/private/tmp/js2-1691-host-exact-after-accessors.jsonl`. Standalone is
**9/13 pass, 4 assertion failures, 0 compile errors, 0 timeouts, and 0
skips**; the local JSONL is
`/private/tmp/js2-1691-standalone-exact-after-accessors.jsonl`.

The four standalone residuals are `thrw-call-non-obj` (the delegated
non-object result's `value` observation), `violation-no-rtrn` (missing
`throw` getter/fallback count), `violation-rtrn-call-non-obj` (caught
TypeError visibility), and `violation-rtrn-invoke` (missing `throw` getter
count). The `res-done-no-value` and `res-value-err` accessor-order rows now
pass in standalone. The host lane's corresponding four rows pass after
routing module-global externref receivers through the dynamic property path
and constructing protocol TypeErrors in the test realm. This checkpoint is
committed separately from the remaining standalone work.

### Resume acceptance

- The current candidate denominator and both-lane baseline are exact.
- The selected cohesive throw-delegation cluster reaches 100% standalone and
  host pass with zero failures, compile errors, timeouts, or skips.
- Normal and return delegation remain green; no eager-host shortcut, fixture
  rewrite, runner exemption, or host-oracle dependency is introduced.
- The upstream PR uses the exact Description/CLA template and remains draft
  until the scoped fix is complete, current-main based, CI-green, and mergeable.

### Closeout handoff — 2026-08-27

The final bounded rerun used the exact 13-row list above, the pinned Test262
checkout, the maintained assembled harness, the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, LLVM 18, and two workers.
The fresh local JSONL artifacts are:

- host: `/private/tmp/js2-1691-host-exact-closeout.jsonl` — **13/13 pass**;
  0 assertion failures, 0 compile errors, 0 timeouts, 0 skips;
- standalone: `/private/tmp/js2-1691-standalone-exact-closeout.jsonl` —
  **9/13 pass**, 4 assertion failures, 0 compile errors, 0 timeouts, 0 skips.

The four standalone residuals are:

- `star-rhs-iter-thrw-thrw-call-non-obj.js`: the delegated primitive result
  reaches the protocol path, but the caught native `TypeError` is observed as
  `undefined`;
- `star-rhs-iter-thrw-violation-no-rtrn.js`: the missing-`throw` getter/fallback
  count remains `0`;
- `star-rhs-iter-thrw-violation-rtrn-call-non-obj.js`: the caught native
  `TypeError` is observed as `undefined`;
- `star-rhs-iter-thrw-violation-rtrn-invoke.js`: the missing-`throw` getter
  count remains `0`.

The current source checkpoint is `66d8238c4` (`fix(generators): preserve
yield-star throw protocol results ✓`), with a clean worktree. It is retained
because it is materially above the prior 548b34de2 checkpoint: host **13/13**
and standalone **9/13** on the exact cohort. No additional uncommitted
experiment is being carried forward.

The host lane is complete for this slice. The remaining standalone failures
are handed off as a substrate follow-up: native `$Error_struct` payloads do not
survive the standardized `try_table` catch binding in the generic standalone
path, and the native plain-object fallback does not observe the accessor
method reads in these two return-fallback rows. Fixing those requires a
separate standalone exception/property-dispatch investigation; no further
scope expansion is made here. Keep the implementation PR draft/hold until
that follow-up (or an explicitly narrowed acceptance decision) is resolved.
