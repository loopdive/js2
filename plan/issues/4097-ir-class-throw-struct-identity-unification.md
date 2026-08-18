---
id: 4097
title: "Lift the IR class-instance-throw demote: unify IR class-allocation struct identity with legacy collectClassDeclaration"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-02
updated: 2026-08-18
loc-budget-allow:
  # +26 lines: the user-class render arm must be built in the SAME
  # index-shift-safe window as the #4394 fnctor arms it mirrors (every helper
  # index and literal global is resolved before either body is built), so it
  # cannot move out of this emitter.
  - src/codegen/native-strings.ts
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: compiler
area: ir
language_feature: exceptions
goal: backend-agnostic-ir
related: [4035, 2877, 2962, 3565, 3784, 2855]
---

# What this is

#4035 made the IR **decline** to lower `throw <class instance>`
(`lowerThrowStatement`, `src/ir/from-ast.ts`, typed
`throw-value-unsupported`), so the function keeps its legacy body. This issue
is about removing that decline by fixing the underlying gap.

**The demote is CORRECT today and must not be reverted on its own.** It trades
IR coverage for correctness, deliberately. Reverting it without the fix below
restores a *silent wrong answer*, which is strictly worse than the coverage
loss — see "Measured behaviour".

# Measured behaviour (2026-08-02, `--target standalone`)

```ts
class Test262Error { message: string; constructor(m: string) { this.message = m; } }
export function test(): number { throw new Test262Error("Expected a to equal b"); }
```

| path | `irCompiledFuncs` | rendered by `extractWasmExceptionMessage` |
| --- | --- | --- |
| IR (before #4035) | `[test, Test262Error_new]` | `"[object Object]"` |
| legacy (`experimentalIR: false`) | `[]` | `"Test262Error: Expected a to equal b"` |
| IR (after #4035's decline) | `[Test262Error_new]` | `"Test262Error: Expected a to equal b"` |

The IR compiled this **without error** and produced the wrong string — it was
not a crash or a fallback, which is why it survived: `tests/issue-2877.test.ts`
had rotted red on `main` and, because untouched root tests never run at PR
time (#3008), nothing reported it until #4035 touched the file.

# Root cause (hypothesis, needs confirming before implementation)

`extern.convert_any` on an **IR-allocated** class struct yields a payload that
the module's own `__exn_render_prepare` → `__any_to_string` cannot *name*, so
it degrades to the generic `"[object Object]"` instead of the
`"<ClassName>: <message>"` shape §20.5.3.4 / #2962 produce.

The suspected mechanism is that **IR class allocation and the legacy
`collectClassDeclaration` pass disagree on struct identity/naming**:

- legacy registers the class name at `src/codegen/class-bodies.ts:765`
  (`ctx.typeIdxToStructName.set(structTypeIdx, className)`), which is what
  `tryStructToString` (`src/codegen/type-coercion.ts:3433`) looks up;
- the IR registers its own struct names via
  `src/ir/integration.ts:5639` / `:5830`.

If the IR's allocation carries a different `typeIdx` than the one legacy named,
the render-side lookup misses and falls through to the opaque branch.

**This is a lead, not a conclusion.** Confirm it by comparing the emitted
struct type indices for the two paths on the same source before building
anything — if the mechanism is different, follow the evidence and re-scope.

# Why it is worth doing

`Test262Error` is the shape test262's own `assert.js` harness throws, so the
render gap plausibly affects triage quality across a large slice of the
standalone suite.

**Treat that as a hypothesis to SIZE, not a number.** Nobody has measured how
many standalone failures currently render opaquely, and the demote does not by
itself change pass/fail for a test that throws either way — it changes what the
harness can *report*. Size it first (count standalone entries whose recorded
error is the opaque label), then decide priority. Do not quote a conformance
delta that has not been measured.

# Root cause — MEASURED 2026-08-15 (the hypothesis above is REFUTED)

Struct identity is **not** the mechanism. Dumping `ctx.typeIdxToStructName` +
`ctx.structFields` at `emitExceptionRenderExports` for the exact repro, on both
paths (`--target standalone`, `hostBridge: always`):

| path | registered class struct | `$Error_struct` | `irCompiledFuncs` | render |
| --- | --- | --- | --- | --- |
| legacy | typeIdx **45** `Test262Error` (`__tag:i32, message:ref_null`) | 49 | `undefined` | `"Test262Error: Expected a to equal b"` |
| IR (decline lifted) | typeIdx **45** `Test262Error` (identical fields) | 77 | `["test","Test262Error_new"]` | `"[object Object]"` |

Same typeIdx, same name, same fields, and the IR-allocated struct IS in
`typeIdxToStructName` — so the render-side lookup does not "miss". The real
divergence is **which value the `new` site allocates**:

- `tryCompileBuiltinGlobalNew` (`src/codegen/expressions/new-builtin-globals.ts:378`)
  claims `new Test262Error(...)` **by name**. Its shadow guard is
  `errorCtorNameIsUserFunctionShadowed`, which matches only a `function`
  declaration (#4394, deliberately narrow) — so a **`class Test262Error`**
  does not decline it. Legacy therefore throws a native `$Error_struct`, which
  `__any_to_string` renders through §20.5.3.4 `__error_to_string`.
- `lowerNewExpression` → `emitClassNew` has no such interception, so the IR
  throws the genuine user-class struct, for which `__exn_render_prepare` had no
  arm → the generic `"[object Object]"` terminal (which is what §7.1.17 says
  for a class with no `toString`, so the compile was not "wrong" — it lost the
  harness signal legacy synthesises).

# Fix

1. `emitExceptionRenderExports` (`src/codegen/native-strings.ts`) gains a
   user-class arm alongside the #4394 declined-fnctor arms: for every struct in
   `ctx.typeIdxToStructName` that is a **local class** (`ctx.classSet`), is not
   `$Error_struct`, and carries a `message` field, render `"<ClassName>: " +
   ToString(message)`. The arm lives in the harness renderer, **not** in
   `__any_to_string`, so in-module `String(obj)` keeps its §7.1.17 behaviour.
2. The `valueType.kind === "class"` arm of the `throw-value-unsupported`
   decline in `lowerThrowStatement` (`src/ir/from-ast.ts`) is removed. The
   numeric arm (`throw 42`) stays deferred — still needs a box helper.

Because the arm is keyed on the struct, it is **path-independent**: legacy and
IR render identically for every user-class payload. Deliberate, symmetric
consequence — a thrown `class MyErr { message }` now renders `"MyErr: boom"` on
**both** paths where both previously rendered `"[object Object]"`. That is a
triage-signal improvement in the same direction as #4394, not an IR-only
behaviour.

# Measured behaviour after the fix (same probe matrix)

| source | legacy | IR |
| --- | --- | --- |
| `class Test262Error { message }` | `Test262Error: Expected a to equal b` | same, `irCompiledFuncs` ⊇ `["test"]` |
| `class MyErr { message }` | `MyErr: boom` | same, `test` IR-compiled |
| `class MyErr { message; toString() }` | `MyErr: boom` | same |
| `class Test262Error extends Error` | `Test262Error: wrapped` | same (IR claims nothing) |
| `function Test262Error` (sta.js shape) | `[object Object]` | same (unchanged) |
| `throw new TypeError("boom")` | `TypeError: boom` | same |
| `class Pt { x }` (no `message`) | `[object Object]` | same |

# Sizing the opaque-render population (acceptance 5)

Measured against `test262-standalone-current.jsonl` (the **standalone** lane's
per-test corpus in `loopdive/js2wasm-baselines`, downloaded 2026-08-15, 48,735
entries — the host-lane `test262-current.jsonl` is the wrong artifact here: the
render path exists only under standalone/WASI):

| population | count |
| --- | --- |
| entries whose recorded error contains `[object Object]` (all `fail`) | 1,212 |
| …of which the render **is** the whole error (the uncaught-throw shape this arm changes) | **2** |
| …`Test262:AsyncTestFailure:Test262Error: [object Object]` (async rejection-reason ToString) | 551 |
| …in-test assertion text (`String(obj)` inside the test — §7.1.17-correct) | 659 |
| entries already carrying a real `Test262Error: <msg>` signature | 7,741 |
| entries carrying the #2870 opaque label | 0 |

Reading: the harness signal is **already intact** today (7,741 rows), because
legacy's name interception synthesises it — which is exactly why #4035's
decline was the right call and why this issue is about lifting it safely, not
about recovering a lost population. The directly-addressed population is small
(2 rows). The 551 async rows are a **different render site** (in-module
`String(reason)` via `__any_to_string`, not `__exn_render_prepare`) and are
deliberately untouched here: changing them means changing spec-correct
`String(obj)` behaviour, which needs its own issue.

So the payoff claim for this issue is coverage, not conformance: `throw <class
instance>` returns to the IR path with the render pinned by value.

# Acceptance

- [x] The struct-identity mechanism is confirmed (or corrected) by direct
      measurement of the emitted type indices, and written down here.
      **CORRECTED** — identical type indices on both paths; see "Root cause".
- [x] IR-lowered `throw <class instance>` renders identically to the legacy
      path — verified **by value**, not by absence of a diagnostic.
      (`tests/issue-4097.test.ts`, 7-row probe matrix above.)
- [x] The `throw-value-unsupported` decline for `valueType.kind === "class"`
      in `lowerThrowStatement` is removed, and `irCompiledFuncs` again contains
      the throwing function (proving the IR body is really in use, not that the
      test merely passes). Pinned by an explicit `toContain("test")`.
- [x] `tests/issue-2877.test.ts` stays **7/7**, and the case above is covered
      by a test that would fail if the render regressed to `"[object Object]"`.
- [~] The opaque-render population is sized and recorded — sized as far as the
      published artifacts allow, and the limit stated rather than estimated
      past (see "Sizing the opaque-render population").

# Test Results (2026-08-15)

- `npx vitest run tests/issue-4097.test.ts` — **5/5 pass** (new).
- `npx vitest run tests/issue-2877.test.ts` — **7/7 pass**.
- `npx vitest run tests/issue-2962.test.ts tests/issue-2969.test.ts` — 22/22 pass.
- `npx vitest run tests/issue-4394-test262-error-ctor-identity.test.ts
  tests/issue-4394-test262-error-instanceof.test.ts
  tests/issue-4394-shadowed-error-ctor.test.ts` — 13/13 pass.
- `npx vitest run tests/issue-3613-render-parity.test.ts` — 2 failures, **pre-existing
  on `origin/main`**: verified by an A/B file-copy revert of both changed sources
  (same 2 failures at base; `tryNativeExnRender` returns null in this container).
- `npm run typecheck`, `npx biome lint` (changed files), `prettier --check`,
  `node scripts/check-func-budget.mjs` — clean. `check-loc-budget` passes via the
  `loc-budget-allow` grant above.

Residual risk, stated plainly: lifting the decline means a function that throws
a class instance is now IR-compiled, so in standalone test262 the thrown
`Test262Error` becomes a real class instance instead of legacy's `$Error_struct`
at those sites. Catch-side field reads (`e.message`, `e.name`) still work for the
runner's harness class (it declares both), and `instanceof` gets *more* correct,
but the merge-queue test262 shards are the gate that arbitrates this.

# Notes

- The numeric arm of the same decline (`throw 42`) is a separate, genuine
  slice-9 deferral (needs a box helper) and is **not** in scope here.
- Budget: `src/ir/from-ast.ts` is a god-file sitting exactly at its LOC ceiling
  (10787). Removing the decline frees lines; do not spend them.
