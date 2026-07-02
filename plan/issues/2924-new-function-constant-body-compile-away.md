---
id: 2924
title: 'new Function("<const>") compile-away MVP — replace the no-op stub'
status: ready
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval
goal: runtime-eval
sprint: current
parent: 1584
depends_on: [2923]
related: [1163, 1584]
---

# #2924 — `new Function("<const>")` compile-away MVP

Slice **B** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-B, §4.4).
Second landable slice — pure AOT, **standalone-safe**, no interpreter.

## Problem

`new Function(...)` / `Function(...)` currently lowers to a **no-op stub**
(`src/codegen/expressions/new-super.ts` ~line 3179): it evaluates the arguments
for side effects and returns `ref.null.extern` — a "function" that returns
`undefined`. Every test that actually _calls_ the constructed function fails
(119 `new Function(` tests fail today, roadmap §5.2), and standalone gets
nothing.

## Key semantic (why this is easier than eval)

Per **§20.2.1.1** `Function(p1, …, pn, body)`, the created function's scope is
**always the global environment** — it never captures the caller's lexical
scope. So there is no environment-reification problem here (that is eval's
Tier-2/§4.1 concern). When the parameter list and body are compile-time
**constant** strings, `new Function("a","b","return a+b")` is semantically
identical to compiling `function (a,b){ return a+b }` at that site.

## Goal

Replace the no-op stub with a compile-away path:

1. Detect the constructor callee is the global `Function` (mirror
   `isGlobalEvalIdentifier` in `eval-tiering.ts` — a `Function` identifier
   resolving only to the `.d.ts` lib declaration, not a local shadow).
2. Resolve each argument with `resolveConstantString` (from `eval-inline.ts`).
   If **all** are constant: the last is the body, the rest are the parameter
   list (comma-split, per §20.2.1.1.1 CreateDynamicFunction).
3. Synthesize `function (<params>) { <body> }` as a foreign SourceFile (reuse
   the #2923-broadened splice machinery) and emit it as a real AOT function
   value (a `funcref`/closure over the **global** scope only).
4. Non-constant arguments keep falling through to the existing path (host import
   today, the Tier-2 interpreter in #2928).

## Edge cases

- **`Function()` no args** → `function anonymous() {}` (empty body). Returns a
  callable that returns `undefined` — but a _real_ callable, not `ref.null`.
- **Multiple param strings** — `new Function("a", "b,c", "return a+b+c")`:
  params flatten across args (`a`, `b`, `c`).
- **Body parse error** → real JS throws `SyntaxError`. Emit the compile-time
  error (matches negative tests) rather than silently returning null.
- **`new` vs plain call** — `Function(...)` and `new Function(...)` are
  equivalent (§20.2.1.1); handle both callee shapes.
- **No lexical capture** — the synthesized function must NOT close over caller
  locals (global scope only). Verify a name used in the body that is a caller
  local resolves as a **global**, not the caller's binding.

## Acceptance criteria

**Slice 1 (this PR) — JS-host lane only:**

- [x] `new Function("a","b","return a+b")(1,2) === 3` on the **JS-host lane**.
      (headline, minus the standalone half — see the gate rationale below)
- [x] single-param + no-param const bodies, single call — host.
- [x] reuse across **separate statements** correct — host.
- [x] a **non-constant** argument bails gracefully to the legacy stub — compiles,
      never miscompiles (negative test).
- [x] **standalone / WASI**: the compile-away is GATED OFF → the pre-existing
      stub (compiles host-free, no miscompile, no trap) — verified by test.
- [x] No regression in existing `new Function` tests (the stub still handles
      every non-const / unsupported / standalone case).

**Gate rationale (ship decision, tech-lead call 2026-07-02):** the synthesized
function has all-externref params, and externref-param closures hit a
**PRE-EXISTING standalone call-marshalling bug** — two calls coexisting in one
expression (`f(1)+f(2)`) or a ≥3-arg call silently return a WRONG value on the
standalone lane. **Control-verified this is NOT this feature's bug and NOT a
quick temp fix**: a plain `function(a:any){ return a+10; }` closure reused as
`f(1)+f(2)` returns the same wrong value in standalone (a typed `a:number`
closure is correct — typed params take a different, working path). Since those
edges can't be detected at the `new Function` site to bail, and we do not ship
silent wrong values in ANY lane (never-miscompile bar), the compile-away is
gated to the JS-host lane. Standalone enablement is **#2945**, blocked on fixing
the externref-param-closure standalone marshalling bug.

**Deferred to follow-up slices (explicit NON-GOALS of slice 1):**

- [ ] **Standalone enablement — #2945** (blocked on the externref-param-closure
      standalone marshalling fix; carries the full collision analysis).
- [ ] Plain-call value form `Function("return 42")()` — routed in `calls.ts`,
      not `compileNewExpression`; not yet wired.
- [ ] `new Function("return")()` / `new Function()()` → `undefined` — currently
      the no-value result is the stub `null`, not the `undefined` singleton.
- [ ] no-capture `typeof x` string-return — the empty-`localMap` global compile
      is in place; the string-return marshalling needs confirming.

## Implementation (dev-f2, 2026-07-02) — slice 1, JS-host lane

`tryCompileConstantFunctionCtor` in `src/codegen/expressions/new-super.ts`,
wired into the `new Function(...)` stub. On the JS-host lane, when every arg is
a constant string it: resolves them via `resolveConstantString`, synthesizes
`function <synth>(<params>) { <body> }` as a foreign `SourceFile`, compiles it
with an **empty enclosing `localMap`** (global scope, no lexical capture —
§20.2.1.1), and escapes it as a callable via `emitCachedFuncClosureAccess`
(stable identity, reusable) / `emitFuncRefAsClosure`. Reuses #2442's
foreign-binding-less `compileNestedFunctionDeclaration` tolerance.
Rollback-guarded (snapshots `mod.functions.length` + `funcMap` so a mid-body
compile throw can't leave a half-registered empty-body function). Standalone /
WASI return early → the pre-existing stub (see the gate rationale above).

`tests/issue-2924.test.ts` (6/6): host working shapes, host reuse-across-
statements, the graceful non-const bail (negative), and the standalone
gated-to-stub clean-compile assertion.

Stacked on #2442 (the eval-broaden `compileNestedFunctionDeclaration`
foreign-tolerance); re-base onto `main` once #2442 lands, then PR.

## Notes

Dynamic-body `new Function` (runtime-computed strings) is deferred to the Tier-2
interpreter (#2928). Umbrella: #1584. Goal: `runtime-eval`.
