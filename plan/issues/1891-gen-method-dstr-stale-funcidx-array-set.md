---
id: 1891
title: "standalone: generator-method destructuring param emits invalid Wasm (array.set externref vs (ref null N)) — over-shifted funcIdx after generator-body late imports"
status: done
created: 2026-06-05
updated: 2026-06-11
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: generators, destructuring-params, late-imports
goal: standalone-mode
sprint: 61
related: [1890, 1839, 1602, 1886, 1530]
claimed_by: codex-developer
claimed_at: 2026-06-06T09:09:55.112Z
pr: 1248
completed: 2026-06-06
---
# #1891 — generator-method dstr param uses an over-shifted funcIdx → invalid Wasm

## Symptom

Standalone **generator-method** with a destructuring param (rest OR no-rest):

```
WebAssembly.compile(): Compiling function #49:"C_gen" failed:
  array.set[2] expected type externref, found call of type (ref null 5)
```

Minimal repros (all `--target standalone`):

```ts
class C { *gen([a, ...rest]: any) { yield a; } }   // INVALID
class C { *gen([a, b]: any) { yield a; } }          // INVALID (no rest!)
class C { *gen({ a, ...rest }: any) { yield a; } }  // VALID (object-rest OK)
```

#3 of the #1890 dstr-rest-param standalone cluster. (#2 trunc_sat → PR #1208;
#1 `__str_flatten` shift → sd-1886.) Note: the **plain** method and **free
function** dstr-rest cases fail with the #1 `__str_flatten` signature, NOT this
one — this `array.set` signature is **specific to generator methods**.

## Root cause — generator-body late imports over-shift the dstr `call`s

In `class-bodies.ts`, a generator method:
1. runs `destructureParamArray` (line ~1509) which emits `call <__extern_length>`,
   `call <__extern_get_idx>` into `fctx.body` (via `buildVecFromExternref` /
   the vec-convert loop in `destructuring-params.ts`), funcIdx re-resolved from
   `ctx.funcMap` at emit time (correct then);
2. THEN `pushBody(fctx)` (line ~1538) moves those dstr instrs into
   `fctx.savedBodies` and compiles the generator body, which registers **new
   in-module helpers** (`__create_generator`, `__gen_create_buffer`,
   `__defineProperty_value`, `__typeof_number`, …) via `ensureLateImport`.

Each registration calls `shiftLateImportIndices`, which walks `fctx.savedBodies`
(so the dstr instrs ARE visited). But the emitted dstr `call`s end up **+5 too
high**: the funcmap dump shows the real `__extern_length` at index 58 and
`__extern_get_idx` at 59, while the emitted dstr `call`s target 63 / 64
(`__defineProperty_value`, `__typeof_number`). The dstr `call`s were
**over-shifted** — shifted by deltas whose insertion point was at/below the
helper they target, so the call drifts above the function it should hit. Same
defect *class* as #1839/#1602/#1890, but the failure mode here is over-shift
during the **deferred** generator-body flush, not a missed shift.

## Routing — NOT a clean dev-lane localized fix

This is entangled with the same late-import shift machinery
(`shiftLateImportIndices` / `flushLateImportShifts` / `pushBody` savedBodies
interaction) that:
- **#1886 (sd)** is touching for the sibling `__str_flatten` over-shift, and
- **#329 (senior-dev, in-flight)**: "@@toPrimitive + late-shift captures —
  re-resolve stale funcIdx after deferred flush + serializer assert".

A dev-lane patch to the shift arithmetic here would collide with both. Recommend
folding #1891 into the senior-dev deferred-flush work (#329 / sd-1886) so the
over-shift is fixed once in the shared machinery, with a serializer assert that
catches a `call` whose resolved target type mismatches the consuming op.

## Acceptance

- The three generator-method dstr repros above compile to a valid standalone
  module and run.
- No regression in non-generator dstr / dstr-param suites.
- A standalone unit test for `*gen([a, ...rest])` and `*gen([a, b])`.

## Final findings

Implemented in branch `symphony/1891`; review PR: #1248.

The local repro refined the stale-index shape: in the array externref conversion
path, `destructureParamArray` built fallback calls to `__extern_length` /
`__extern_get_idx`, then recursively entered the typed vec destructuring path.
That typed path manually swapped into a detached `destructInstrs` buffer and
kept the new buffer visible to late-import fixups, but it did not keep the
previous body visible. When `emitBoundsCheckedArrayGetUndef` later added the
`__get_undefined` import, the real native object-runtime helper slots shifted,
but the fallback calls in the previous body stayed stale-low and landed on the
adjacent object helper slots.

Fix: route both nullable tuple and vec destructuring body swaps through the
existing `pushBody` / `popBody` helper so the active destructuring buffer and the
saved previous body are both reachable to `shiftLateImportIndices`.

Validation:
- `node node_modules/vitest/dist/cli.js run tests/issue-1891.test.ts`
- `node node_modules/vitest/dist/cli.js run tests/issue-1891.test.ts tests/issue-1314.test.ts tests/issue-1553d.test.ts tests/equivalence/basic-destructuring.test.ts tests/equivalence/destructuring-type-coercion.test.ts tests/generator-method-destructuring.test.ts`

Note: an accidental broad `pnpm test -- tests/issue-1891.test.ts` invocation
expanded beyond the target file and eventually OOMed after reporting unrelated
baseline failures. The scoped direct Vitest commands above are the relevant
validation for this issue.
