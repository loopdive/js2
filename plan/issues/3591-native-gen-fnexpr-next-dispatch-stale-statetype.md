---
id: 3591
title: "Native generator fn-expr: .next() dispatch tests a stale pass-1 state-struct type (4 silent regressions from #3032 W6)"
status: ready
sprint: current
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
created: 2026-07-24
assignee: null
---

# #3591 — `.next()` on a variable-bound generator function expression throws TypeError (standalone)

## Summary

In the **standalone** lane, a generator **function expression** bound to a
module-scope variable compiles host-free and then **throws a `TypeError` at
runtime** when consumed via `.next()`:

```ts
var g = function* gen() {
  yield 3;
};
export function test(): number {
  const it: any = g();
  return it.next().value; // → TypeError: Generator.prototype.next requires that 'this' be a Generator
}
```

The module reports `success: true` with **zero `env` imports**, then traps out of
`test()` with an uncaught Wasm exception. `for-of` over the _same_ generator
works — only the `.next()/.return()/.throw()` member-call path is broken.

This is a **real product regression**, not a stale test (see Attribution).

## Reproduction / affected shapes

Measured on `origin/main` @ `7652f033774194`, `target: "standalone"`:

| #   | shape                                            | result       |
| --- | ------------------------------------------------ | ------------ |
| A   | `function* gen(){}` decl → binding `.next()`     | **3** ✓      |
| B   | `var g = function* gen(){}` → binding `.next()`  | **THROWS** ✗ |
| C   | `var g = function*(){}` → direct `g().next()`    | **THROWS** ✗ |
| D   | `function* gen(){}` decl → direct `gen().next()` | **3** ✓      |
| E   | `var g = function*(){}` → `for (v of g())`       | **3** ✓      |
| F   | `var g = function*(){}` → `for (v of it)`        | **3** ✓      |
| G   | `const g = function*(){}` → direct `g().next()`  | **THROWS** ✗ |
| H   | fn-expr IIFE _inside_ a function → `.next()`     | **3** ✓      |

So the break is exactly: **generator function expression lifted at MODULE
scope, consumed through the `.next()` open dispatch.** Declarations are fine
(registered once, by name). IIFEs inside a function body are fine (lifted once).

The thrown value is a `WebAssembly.Exception` carrying a real `TypeError` whose
message is exactly 60 chars — `Generator.prototype.next requires that 'this' be
a Generator` — i.e. the #1344 `emitBrandCheckTypeError` arm in
`src/codegen/generators-native-consumer.ts` (`buildNativeGeneratorDispatch`).

## Root cause (diagnosed, not guessed)

`compileDeclarations` compiles the **module-init body twice**:

- pass 1 — `src/codegen/declarations.ts:2312` ("early closure/setup discovery")
- pass 2 — `src/codegen/declarations.ts:2438` ("Recompile module init after
  top-level functions are compiled so call sites inside module-level code can
  see the final inlinable-function registry")

Top-level **function bodies are compiled between the two passes**. For a
module-scope generator function expression, `compileArrowAsClosure`
(`src/codegen/closures.ts:1894`) allocates a **fresh** `__closure_<n>` id and a
**fresh** state-struct type on _each_ pass. Instrumented compile of shape B:

```
[DBG] closure gen-expr closureName=__closure_0 selfTypeIdx=57  nodePos=7
[DBG] register nativeGenerator name=__closure_0 stateTypeIdx=61
[DBG] methodCall .next() receiverType={"kind":"externref"} registered=[["__closure_0",61]]
[DBG] closure gen-expr closureName=__closure_1 selfTypeIdx=108 nodePos=7
[DBG] register nativeGenerator name=__closure_1 stateTypeIdx=111
```

Same AST node (`nodePos=7`) → **two registrations, two state-struct types**.

`buildNativeGeneratorDispatch` emits an **inline `ref.test` chain** over
`ctx.nativeGenerators` _at the point the consuming function body is compiled_ —
i.e. between the passes, when only `__closure_0`/`61` exists. Pass 2's module
init is the one that survives, so at runtime `g` holds the `__closure_1` closure
whose factory does `struct.new 111`. `ref.test 61` fails, the chain falls
through to the `typeErrArm`, and the #1344 TypeError is thrown.

### Why `for-of` survives and `.next()` does not

`for-of` goes through the `__iterator` runtime's **GENSTATE arm**
(`src/codegen/iterator-native.ts`), which is **filled at finalize** by
`fillNativeIteratorLateArms` — by then _all_ registrations (including
`__closure_1`/`111`) are visible. The `.next()` dispatch is **inline and frozen
mid-compile**. That asymmetry is the whole bug.

### Why a naive fix does not work

Reusing pass 1's `NativeGeneratorInfo` on pass 2 is **not** sound as-is: the
lifted closure's `self` struct type also differs per pass (`57` vs `108` above),
and the state struct's `__self` field is typed `ref_null <selfTypeIdx>`. Pass 2
would store a type-108 self into a field typed `ref_null 57` → invalid Wasm.

## Suggested fix (two candidates)

1. **Late-fill the resume-method dispatch** (architecturally consistent —
   mirrors what already works for `for-of`): have
   `tryCompileNativeGeneratorMethodCall` emit a **call to a generated
   `__gen_dispatch_{next,return,throw}` helper** whose body is filled at
   finalize from the complete `ctx.nativeGenerators`, instead of an inline
   `ref.test` ladder frozen mid-compile. Needs care with the dispatch block's
   `resultType` (today it is computed from the generators known so far).
2. **Memoize the lifted closure per AST node for generator fn-exprs.** The
   #3164 admission gate already requires **no outer capture**, so such a closure
   is capture-free and _is_ safely shareable across both module-init passes —
   reuse the same `__closure_<n>`, `selfTypeIdx` and `stateTypeIdx` on pass 2.
   Smaller in principle, but touches closure lifting/DCE registries.

Candidate 1 is the more general fix: it also covers any future late
registration, not just the two-pass module-init case.

## Attribution — bisected, first-bad commit

- **last good**: `8bc6e1c3ccea74` (`feat(#3462)`) — `tests/issue-3164.test.ts` +
  `tests/issue-3386.test.ts` = **30/30 pass**
- **first bad**: `1fbb1810bd071361aea025a7a3878e95bb338c43` —
  `feat(#3032): W6 — host-lane generator declarations route native (lazy §27.5 +
next(v) two-way); GenState brands; sentinel-undefined reads (#3356)`,
  merged **2026-07-19** — the _same two files_ = **26/30, 4 failed**
- The four failures at the culprit are byte-identical to the four still failing
  on `main` @ `7652f033774194` today.

`git bisect` over the 2,937-commit range `a5220f56..7652f033` (12 steps,
automated probe on shape B) converged on that single commit. Both suites
predate it (`tests/issue-3164.test.ts` @ `a5220f56`, 2026-07-12;
`tests/issue-3386.test.ts` @ `3fa9b754`, 2026-07-18), and both were green at its
parent.

Most likely mechanism of exposure: W6's **"GenState brands"** made the two
passes' state structs no longer structurally identical, so they stopped
collapsing to a single deduped type index — turning a previously-harmless
double registration into a live type mismatch.

## Why this went unnoticed for 5 days

Neither suite was in the **required-checks** set:

- the #3008 per-PR gate only runs `tests/*.test.ts` files a PR **touches**, and
  #3356 touched neither;
- the heavy test262 shard matrix is `merge_group`-only and does not run root
  test files at all.

So #3356 could land fully green while breaking four assertions. Mitigated in
this issue's PR by folding both suites into the required guard suite
(`tests/guard-suite.json`, #3552) — the same class of fix as #3561/#3562/#3565.

## Acceptance criteria

- [ ] Shapes B, C, G above return their expected values host-free (zero `env`
      imports) in the standalone lane.
- [ ] The four `it.skip`ped cases are re-enabled (search `#3591` in
      `tests/issue-3164.test.ts` and `tests/issue-3386.test.ts`) and pass.
- [ ] `tests/issue-3164.test.ts` (13) and `tests/issue-3386.test.ts` (17) are
      fully green, still in `tests/guard-suite.json`.
- [ ] No new `env` imports in the standalone lane for any generator shape.

## Related

- **#3586** (`s += yield` compound-assign not claimed by the native generator —
  eager-buffer fallback), filed by the substrate + async review in PR #3578. Same
  native-generator territory as this issue's shape-gate work; worth reading
  together, since both concern which generator shapes the native path actually
  claims.

## Note — renumbered from #3584

This issue was originally filed as **#3584**, which collided with
`plan/issues/3584-auto-enqueue-blind-to-workflow-touching-prs.md` (PR #3577,
merged first — id reserved on `origin/issue-assignments` at 2026-07-24T22:05:41Z,
~29 min before this branch's PR was opened). The `check:issue-ids:against-main`
gate (#2531) caught it at PR level once #3577 landed on `main`.

Renumbered to **#3591** (fresh id via `claim-issue.mjs --allocate`) by the
PR-queue shepherd, since the authoring session was unreachable. The change is
purely mechanical — file rename plus id/reference rewrites in
`tests/issue-3164.test.ts`, `tests/issue-3386.test.ts` and
`tests/guard-suite.json`. **No test expectation, assertion or source behaviour
was touched.**
