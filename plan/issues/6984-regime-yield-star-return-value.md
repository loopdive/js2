---
id: 6984
title: "regime: the value of a `yield*` expression is the delegate's return value in every position (native generator lowering)"
status: done
sprint: current
created: 2026-10-14
updated: 2026-10-15
completed: 2026-10-15
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: generators
goal: architecture
parent: 5385
related: [680, 6708, 6798, 6980, 6981]
assignee: "ttraenkler/opus-6984-yieldstar"
branch: "issue-6984-regime-yield-star-return"
loc-budget-allow:
  # 2026-10-14 (#6984) +8: one import entry (delegation-runtime helpers) plus the
  # two call sites in compileState — the helper bodies live in
  # generators-delegation-runtime.ts, not the god-file.
  - src/codegen/generators-native.ts
func-budget-allow:
  # 2026-10-14 (#6984) +3: the vec-delegation completion slot picks its
  # `undefined` by slot type, and the native-gen arm forwards `.next(v)` to the
  # delegate — both one-call sites into generators-delegation-runtime.ts.
  - src/codegen/generators-native.ts::compileState
---

# #6984 — `yield*` completion value under the native regime

## Problem

Under the native semantic regime (`semanticProviders: "native-first"` in a JS
environment) and `target: "standalone"` alike, the value of a `yield*`
expression was not the delegate generator's return value. It was the last red
row blocking the #6708 default flip:
`tests/equivalence/issue-6798-misc-semantics.test.ts` :: "yield-star-return: the
delegate's return value is the yield* expression's value in every position".

The host-assisted lane got this right by delegating to the host generator
protocol, which S7 deletes. Both regime lanes run the host-free native generator
state machine (#680, `src/codegen/generators-native.ts`).

## Root cause

Probing the eight generators of the equivalence row one by one showed three
independent defects, not one:

1. **Nested `yield*` refused (#680 diagnostic).** `yield (yield* g())`,
   `"o:" + (yield* g())`, `id(yield* g())` — and template substitutions,
   `return "R" + (yield* g())` — were compile errors. The planner has direct arms
   for `yield* E;`, `x = yield* E;`, `const x = yield* E;` and `return yield* E;`;
   anything else reaches the #6651 nested-yield planner
   (`generator-yield-nested.ts`), whose evaluation-order walk set
   `failed = true` on every `yield*`.
2. **Spread silently dropped the generator.** `[...o8()]` where `o8` delegates:
   the delegating generator rides the boxed-any (externref) carrier while the
   literal's element type is `number[]` (f64 vec). The native-generator spread arm
   in `compileArrayLiteral` (`literals.ts`) treated that mismatch as a
   "conservative skip" — `drop` + `continue` — so the spread contributed nothing
   and `[...o8()]` was `[]`. A silent miscompile, not a refusal.
3. **`.next(v)` never reached a native-generator delegate.** The native-gen
   delegation arm resumed the inner generator without copying the outer's `sent`
   field into it, so `const a = yield 1` inside the delegate read NaN. This
   affected the direct `const r = yield* inner()` form too (pre-existing).

## Fix

- **Walk (`generator-yield-nested.ts`).** A `yield*` with a yield-free operand is
  now one suspension EVENT in the evaluation-order walk. The planner suspends on
  it through the same `host.suspend` → `emitYield` path every direct arm uses,
  which delegates into a spill (`bindResultTo`, already written by all three
  delegation kinds: native-gen, numeric vec, protocol iterable). The deferred
  statement then reads that spill through the existing yield replacement map
  (`fctx.nativeGeneratorYieldValueLocals` covers any `YieldExpression`, `yield*`
  included). Order safety is the walk's existing proof — what is evaluated before
  the `yield*` must be replayable or captured, else the statement refuses.
- **Gate.** `bodyHasNestedDelegation` adds a fourth generator-level gate to
  `bodyHasNestedYieldShape`: a `yield*` outside the four direct positions whose
  enclosing statement the walk models. Only those generators move to the boxed-any
  carrier; every one of them was a #680 refusal before, so programs without such a
  `yield*` compile byte-identically.
- **Vec completion slot.** In a boxed-any frame the completion slot is externref;
  the vec-delegation done-arm wrote an f64 NaN into it (invalid Wasm, now reachable).
  `delegationUndefinedInstrs` picks the canonical `undefined` for an externref slot.
- **Spread (`literals.ts`).** Drain the generator into its carrier's own vec; the
  existing Step 3 fill loop already coerces each element to the result type (the
  #42 Set arm relies on the same contract).
- **Sent forwarding.** `delegateSentForwardInstrs` copies the outer's `sent` into
  the delegate's before each resume (coerced externref → f64 when the carriers
  differ), §27.5.3.7 step 7.a.i.

Not touched (#6980's lane): GetIterator on user objects, generator `.return()`
plumbing, async generators.

## Acceptance

- `tests/issue-6984-regime-yield-star-return.test.ts` — every position under
  native-first (JS environment) AND standalone, against the JS oracle: statement,
  assignment, argument, binary, template, return, member target; a delegate
  returning `undefined`; a delegate that throws; `yield*` of an array and of a
  string (completion `undefined`); `next(v)` forwarding; `throw()`/`return()`
  mid-delegation; and a CONTROL that a nested `yield*` inside a loop body still
  refuses with the #680 diagnostic rather than miscompiling. 8 of the 9 cases fail
  on the base sources (measured: 7 of the first 8 before the array-literal pin was
  added; that pin is the former refusal below).
- `tests/issue-680-generator-expression-continuations.test.ts` "fails closed for
  yield-star operand" (`[yield* [1]];`) is retired the same way #6651 A4/A5
  retired their rows: the shape now runs (`1;false;true`, JS-equal) and is
  pinned positively in the #6984 test.
- The #6798 equivalence row passes under the regime.

## Left out

- A delegate whose own body is outside the native subset still refuses on its
  own (e.g. `function* echo() { const a = yield 1; return "e" + a; }` — a resume
  binding in a boxed-any carrier, the `carrierIsAny` bail in the spill-typing
  loop). Unrelated to `yield*`.
- A nested `yield*` inside a loop / if body or a try region keeps refusing: the
  nested planner is direct-body-only (`allowExpressionContinuations`), same scope
  as #6651 A5/A6.
- The default (host) lane has its own `yield*` divergences seen while probing
  (`return "R" + (yield* g())` → `0`, `c.return(v)` mid-nested-delegation,
  `next(v)` forwarded as `null`). That lane is retired by S7; not in scope.
