---
id: 5186
title: "stack-balance (#1058) hard error refuses a shared body the repair pass never touches — 2,580 standalone CEs, net −947"
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29
priority: critical
horizon: m
task_type: bugfix
area: codegen
goal: correctness
sprint: current
assignee: ttraenkler/opus-dev-5186
feasibility: hard
reasoning_effort: max
related: [5180, 5183, 5184, 1058]
loc-budget-allow:
  # 2026-08-29 — +51 lines in the god-file, of which ~40 are the doc comment on
  # `isContextInvariantBody` that carries the SOUNDNESS PROOF for relaxing a
  # hard compile error (the `fixBranch` UNREACHABLE early-out plus the fact
  # that `fixBranchType` has exactly one call site, inside `fixBranch`). The
  # executable change is ~12 lines. Splitting the predicate into a new module
  # would separate the proof from the guard it justifies, which is the failure
  # mode that produced this regression in the first place.
  - src/codegen/stack-balance.ts
---

# stack-balance (#1058) hard error refuses a shared body the repair pass never touches

## Impact

`main` carried a net **−947** test262 regression (35,377 → 34,430) from
**2,580 standalone `compile_error`s**, all one family. Every merge group failed
its regression gate against the pre-regression baseline, so the whole queue was
blocked and PRs #5188 / #5212 / #5216 were parked behind it.

Victims: 15× `built-ins/Error/prototype/stack/**` (`makeNativeError`), 7×
harness `deepEqual-*` / `testTypedArray*` closures, 2× `instanceof
S15.3.5.3_*`, plus 2,556 absorbed into existing path buckets.

## Attribution

Introduced by `8f161cbf15` ("feat(selfhost): compile TypeScript 5 parser graph
to Wasm", PR #5204), established by dev-5180's per-commit walk. That commit
converted the stack-balance pass from a **tree** walk to a **DAG** walk —
`eliminateDeadCode`, `fixBody` and `assertLocalRefsInRange` all gained
visited-sets (`walkInstructions` → `walkInstructionDag`) so the selfhost
parser's heavily-shared instruction graph terminates in linear time instead of
re-walking every shared subtree once per incoming edge.

Visiting each physical array **once** is what makes the pass affordable on that
graph, but it also means the single repair applied to a shared array has to be
valid for *all* of its owners. `contextAmbiguousFunctions` was added in the same
commit as the correctness guard for that: it fails the compile
(`recordHardStackBalanceError`, `src/codegen/stack-balance.ts:~2803`) when one
array is reached from two different functions, or from two different block
contexts inside one function.

## Root cause

The **block-context** half of that guard is too coarse. It compares
`branchContextKey(expected, blockType)` for every incoming edge, but the repair
it is protecting is not always context-sensitive.

Measured on every victim (`JS2WASM_DEBUG_SHARE` instrumentation of the
preflight, 2026-08-29), the conflict is **one shape, 100 % of the time** — never
the cross-function arm:

```
[share] context: func="makeNativeError" priorVia=if.then@makeNativeError[6] nowVia=if.then@makeNativeError[12]
        prior=0:{"kind":"empty"} now=1:{"kind":"val","type":{"kind":"externref"}}
        len=4 ops=global.get,extern.convert_any,call,throw
```

That body is a **terminal throw** — stack-polymorphic. It validates as a void
`if` arm and as an externref-valued `if` arm alike, which is exactly why the
producer shares it. The producer is `src/codegen/expressions/calls.ts:4921-4934`
(`wantTaCtorArm`, the `$__ta_ctor` [[Call]] arm): one
`buildThrowJsErrorInstrs(...)` array is used both as

- `then:` of an `{kind:"val", type:externref}` `if` (calls.ts:4932 — its own
  comment already says *"terminal throw — stack-polymorphic, validates as
  externref"*), and
- `onMatch` inside `buildInt8ArrayCarrierMatch`, which nests it as `then:` of an
  `{kind:"empty"}` `if` (`src/codegen/dataview-native.ts:3570`).

Two contexts, one array — refused, and the refusal takes down the **whole
function**, hence the blast radius.

The refusal is provably unnecessary here. The only context-dependent repairs in
the pass are `fixBranch` (value count) and `fixBranchType` (value type), and
`fixBranchType` is reachable **only** from inside `fixBranch`
(`stack-balance.ts:1109`, the single call site). `fixBranch` opens with

```ts
const actual = sequenceDelta(body, types, sigs);
if (actual === UNREACHABLE) return 0; // unreachable branch -- validator accepts anything
```

and `sequenceDelta` returns `UNREACHABLE` as soon as any element's `instrDelta`
does — which is exactly the `isTerminator` op set (`return`, `return_call`,
`return_call_ref`, `br`, `throw`, `rethrow`, `unreachable`) and nothing else
(structured blocks report their `blockType` delta, never `UNREACHABLE`). So
"this array contains a top-level terminator" is *identical* to "`fixBranch`
returns 0 without mutating it", for **every** `expected` / `blockType`.

## Decision: (b) — fix the repair pass, not the producers

Both routes were on the table.

**(a) Producers emit distinct arrays** (the error message's own advice) — a
one-line `[...throwInstrs]` at `calls.ts:4924` clears this family. Rejected as
*the* fix:

- It treats a **legitimate** producer pattern as a defect. Sharing one terminal
  throw sequence across arms of different block types is sound Wasm and the
  author had explicitly reasoned it through in the comment at calls.ts:4932.
- It is site-by-site. There are ~40 `buildThrowJsErrorInstrs` call sites and
  more terminal-sequence builders besides; any of them can reintroduce the
  same failure, and the next occurrence is another queue-blocking
  multi-thousand-CE event.
- It duplicates instructions in the emitted module for no validator benefit.

**(b) Teach the preflight what it is actually protecting** — chosen. A body that
is stack-polymorphic is *repair-invariant with respect to block context*, so
differing incoming contexts are not a disagreement and must not fail the
compile. This is provable from the two functions above rather than heuristic,
it is general (covers every producer, present and future), and it is ~15 lines.

Explicitly **not** done: demoting the hard error to a warning. The invariant
`8f161cbf15` needs is that a once-visited shared array is repaired identically
for all owners; that invariant is preserved exactly, and the two arms that
really can disagree still fail closed —

- a shared body whose repair **does** depend on the context (no terminator:
  `fixBranch` would append a `drop` for the empty arm and leave a value for the
  valued arm) is still refused;
- the **cross-function** `firstOwner` refusal is untouched. Stack-polymorphism
  says nothing there: `fixLocalSetCoercion` / `fixCallArgTypesInBody` /
  `fixStructNewFieldCoercion` resolve local indices against the owning
  function, so a body shared between two functions is unsafe regardless of how
  it ends.

## Fix

`src/codegen/stack-balance.ts` — in `contextAmbiguousFunctions`, skip the
context-key comparison for bodies where `isContextInvariantBody` holds (a
top-level terminator is present). Memoized in a `WeakMap` so a heavily-shared
DAG stays linear in instructions rather than in edges, preserving the
performance property `8f161cbf15` added the DAG walk for.

## Test Results

`tests/issue-5186-stack-balance-shared-throw-body.test.ts` — 4 cases, all
verified to fail/pass in the right direction by swapping the base file back in:

| case | base | fixed |
| --- | --- | --- |
| shared terminal throw across empty + valued `if` arms → no error, body unmutated | FAIL | PASS |
| construct-owner + plain-call-owner TS source, standalone → clean compile + `WebAssembly.compile` | FAIL | PASS |
| context-sensitive shared body still refused (guard) | PASS | PASS |
| terminal throw shared across two functions still refused (guard) | PASS | PASS |

Family victims, `runTest262File(..., "standalone")`, before → after:

| file | base | fixed |
| --- | --- | --- |
| `harness/deepEqual-circular.js` | compile_error | **pass** |
| `harness/deepEqual-array.js` | compile_error | **pass** |
| `harness/deepEqual-deep.js` | compile_error | **pass** |
| `harness/deepEqual-object.js` | compile_error | **pass** |
| `harness/deepEqual-mapset.js` | compile_error | **pass** |
| `built-ins/Error/prototype/stack/getter-error-instance.js` | compile_error | fail (runtime) |
| `built-ins/Error/prototype/stack/getter-data-property-shadows.js` | compile_error | fail (runtime) |
| `built-ins/Error/prototype/stack/getter-error-as-prototype.js` | compile_error | fail (runtime) |
| `built-ins/Error/prototype/stack/getter-error-prototype.js` | compile_error | fail (runtime) |
| `built-ins/Error/prototype/stack/getter-subclass.js` | compile_error | fail (runtime) |
| `built-ins/Error/prototype/stack/instance-no-own-stack.js` | compile_error | fail (runtime) |

The `Error/prototype/stack` family clears the hard error but still fails at
runtime — that matches its **pre-regression** state (dev-5180 measured
`getter-error-instance.js` failing at runtime at `8f161cbf15^`), so it is not a
pass this fix owns. The recovered passes live in the other victims; the merge
group measures the aggregate.

Selfhost lane, unchanged: `tests/issue-1058-*.test.ts` — **45 files, 151 tests,
all passing**, including `issue-1058-stack-balance-dag.test.ts`'s own
"refuses one shared leaf with incompatible valued and empty block contexts".
