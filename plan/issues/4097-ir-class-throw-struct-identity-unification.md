---
id: 4097
title: "Lift the IR class-instance-throw demote: unify IR class-allocation struct identity with legacy collectClassDeclaration"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
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

# Acceptance

- [ ] The struct-identity mechanism is confirmed (or corrected) by direct
      measurement of the emitted type indices, and written down here.
- [ ] IR-lowered `throw <class instance>` renders identically to the legacy
      path — verified **by value**, not by absence of a diagnostic.
- [ ] The `throw-value-unsupported` decline for `valueType.kind === "class"`
      in `lowerThrowStatement` is removed, and `irCompiledFuncs` again contains
      the throwing function (proving the IR body is really in use, not that the
      test merely passes).
- [ ] `tests/issue-2877.test.ts` stays **7/7**, and the case above is covered
      by a test that would fail if the render regressed to `"[object Object]"`.
- [ ] The opaque-render population is sized and recorded, so the payoff claim
      is a measurement rather than an assumption.

# Notes

- The numeric arm of the same decline (`throw 42`) is a separate, genuine
  slice-9 deferral (needs a box helper) and is **not** in scope here.
- Budget: `src/ir/from-ast.ts` is a god-file sitting exactly at its LOC ceiling
  (10787). Removing the decline frees lines; do not spend them.
