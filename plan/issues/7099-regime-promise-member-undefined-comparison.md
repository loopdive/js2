---
id: 7099
title: "Regime gap: `p.then === undefined` (and `p.constructor === undefined`) compares true on a native promise receiver — the undefined-comparison path bypasses the `$Promise` dynamic read"
status: done
completed: 2026-10-20
assignee: ttraenkler/opus-7099-undef-cmp
created: 2026-10-20
updated: 2026-10-20
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: Promise
goal: architecture
sprint: current
parent: 5385
related: [7092, 7090, 6979]
---

# #7099 — `=== undefined` on a native promise member

Found by #7092 (2026-10-20). After that fix a dynamic read of `p.then`,
`p.constructor` or `p[Symbol.toStringTag]` on a native promise receiver
answers the right value on native-first and standalone, but the comparison
form `p.then === undefined` still evaluates to `true` (so does
`p.constructor === undefined`). The equality-with-`undefined` lowering takes
a different path from the plain member read: it tests the receiver's own
property table (or a specialised "missing member" probe) and never reaches
the `$Promise` arm of `__extern_get` that the read uses. The same path
answers `typeof p.then === "undefined"` wrongly where the comparison is
folded.

## Plan

1. Measure: a `.tmp` probe on native-first (JS environment via
   `wrapCompiledExports`) and standalone against Node — `p.then ===
   undefined`, `p.then == null`, `p.then !== undefined`, `typeof p.then`,
   `p.then ? 1 : 0`, `!!p.then`, the same for `constructor` and
   `Symbol.toStringTag`, for `p = new Promise(...)`, `Promise.resolve(1)` and
   `Promise.withResolvers().promise`; also a plain user object and a Map to
   confirm the comparison path is promise-specific. Record which forms are
   wrong and which lowering they take (`src/codegen/expressions/` equality /
   `undefined`-comparison helpers vs. `promise-dynamic-member-read.ts`).
2. Fix: the undefined-comparison and truthiness lowerings route a member
   read whose receiver may be a `$Promise` through the same dynamic read the
   plain form uses (provider code, or a routing-only edit in the comparison
   helper, which the direct-AST freeze allows); keep every binary that never
   compares a promise member byte-identical.
3. Tests: a focused test under native-first and standalone vs Node; extend
   `tests/issue-7092-promise-constructor-member-read.test.ts`.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; `check:host-import-policy` unchanged.

## Measurements (2026-10-20)

Probe `.tmp/probe7099.mts`: `export function main(): number { <decl>; <form> }`,
`skipSemanticDiagnostics`, run through `buildCompiledImports` +
`wrapCompiledExports` on native-first (`semanticProviders: "native-first"`, JS
environment) and on `target: "standalone"`, compared with Node in a fresh `vm`
realm. Both lanes gave identical rows, so one column per state.

Receivers `new Promise(executor)` (typed and `any`), `Promise.resolve(1)`,
`Promise.withResolvers().promise` all gave the same rows:

| Member | Form | Before | After | Node |
| --- | --- | --- | --- | --- |
| `then`, `constructor` | `=== undefined` | 1 | 0 | 0 |
| `then`, `constructor` | `== null` | 1 | 0 | 0 |
| `then`, `constructor` | `!== undefined` | 0 | 1 | 1 |
| `then`, `constructor` | `typeof … === "undefined"` | 0 | 0 | 0 |
| `then`, `constructor` | `x ? 1 : 0`, `!!x`, `if (x)` | 1 | 1 | 1 |
| `catch`, `finally` | `=== undefined`, `=== null`, `== null`, `undefined === x`, `p?.m === undefined` | wrong (1) | 0 | 0 |
| `[Symbol.toStringTag]` | every form | right | right | — |

Controls: a user object `{ then: 1, constructor: 2 }` was right in every form
before and after. A `Map` answers `constructor` and `[Symbol.toStringTag]`
wrongly in EVERY form (`typeof`, truthiness, comparison) before and after —
a different gap (the Map receiver's prototype data properties are not
answered at all), not this comparison path, so it is left out.

**Which lowering.** `typeof p.then` and the truthiness forms compile the
member through `compileExpression`, whose member arm calls
`notePromiseDynamicMemberRead` (#6651 D5) — the demand hook that mints the
`%Promise.prototype%` closures and enables the `$Promise` arm of
`__extern_get`. The nullish comparison (`binary-ops.ts` →
`compileNullishObservedExpression` → `compilePropertyAccessForNullishObservation`
in `src/codegen/property-nullish-read.ts`) emits the same `__extern_get(p,
"then")` call but never ran the hook. In a module whose only read of the
member is the comparison, the arm was therefore absent (the module's
`__extern_get` body was 1,031 vs 1,131 lines with the arm), and the read fell
through to "no such member". `[Symbol.toStringTag]` was right because the
element form goes through `compileExpression`.

## Implementation notes

- **Fix.** `compilePropertyAccessForNullishObservation` calls
  `notePromiseDynamicMemberRead(ctx, fctx, expr)` first. That is a demand
  only: it emits nothing into the body, and declines unless the lane is the
  native regime off WASI (`ctx.standalone && !ctx.wasi`; `ctx.standalone` is
  the native semantic regime, #5385, which native-first in a JS environment
  also selects), the name is a `%Promise.prototype%` member or data
  key, and the source file names `Promise`. Placed before the early returns
  so `p?.then === undefined` (the `questionDotToken` delegation) is covered.
- **Freeze.** Routing-only: the comparison helper now reaches the promise
  provider's existing demand hook; no new semantics in a direct-AST body
  emitter (plan/method/ir-only-development-freeze.md).
- **No host import**; the arm, the closures and `__promise_proto_ctor` are
  the provider code #6651/#7092 already emit for the plain read.

## Verification (2026-10-20)

- **Byte identity** (`.tmp/hash7099.mts`): 2,953 program literals — every one
  embedded in `tests/equivalence/*.ts`, plus every literal that contains
  `Promise` in a `tests/*.test.ts` file — compiled on gc, native-first,
  standalone and WASI before and after, SHA-256 compared. 0 of 11,812
  binaries differ. Compile errors are the same set before and after (gc 267,
  native-first 312, standalone 265, WASI 294; mostly source fragments).
- **Receivers the IR or a helper produce** (`.tmp/probe7099c.mts`): an `any`
  receiver returned by a helper, a `Promise<number>` parameter and an `any`
  parameter compared with `== null` all answer 0 on both lanes, as Node does.
- **Equivalence gate** (`scripts/equivalence-gate.mjs`, run locally with
  `--configLoader runner`): 20 failing, 2,020 passing, 22 known failures in
  the baseline, "✓ No new equivalence regressions." The two baseline failures
  it reports as now passing (`delete-sentinel`, `reflect-api`
  `Reflect.construct`) are the same two #7092 saw on the same base; every
  equivalence binary is byte-identical, so they are not this change.
- `check:host-import-policy` passes (no new import); tsc has no errors;
  Biome lint and Prettier are clean on the touched files.

## Test

`tests/issue-7092-promise-constructor-member-read.test.ts` gains a #7099
block of 6 cases on native-first and standalone (zero imports asserted),
each compared with Node: `then === undefined`, `constructor === undefined`
on a typed receiver, `== null` / `!== undefined` / `!= null`, `catch` and
`finally` against `undefined` and `null`, reversed operands and `p?.m`, and a
user-object control. Each case reads the member only through the comparison.
On base, 10 of the 12 new tests fail (the control passes on both lanes); the
file is 42/42 green with the fix.
