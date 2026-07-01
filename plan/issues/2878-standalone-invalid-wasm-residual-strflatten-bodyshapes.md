---
id: 2878
title: "Standalone: invalid Wasm residual — __str_flatten + user-body shapes (test/inner/fn) after #2868 URI-carrier fix"
status: done
assignee: ttraenkler/dev-2878
completed: 2026-07-02
created: 2026-06-30
updated: 2026-07-02
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2860, 2868]
umbrella: 2860
---

# Standalone: invalid Wasm — residual after #2868

#2868 fixed the `__uri_encode`/`__uri_decode` carriers (root cause: a shared
`throwURIError` `Instr[]` aliased the same `call`/`throw` Instr objects across
~13 spread sites, so `shiftLateImportIndices` over-shifted the shared `funcIdx`
once per occurrence — fixed by making it a fresh-Instr factory). This follow-on
tracks the **rest** of the #2868 invalid-Wasm surface that the URI fix did not
cover.

## Remaining buckets (from the #2868 measurement, 2026-06-30)

| function | tests | note |
| -------- | ----- | ---- |
| `test` (harness/user) | 199 | a common emitted body shape |
| `inner` | 81 | nested function shape |
| `fn` | 42 | |
| `__str_flatten` | 10 | native string flatten (String split RegExp-arg path) |
| `C_setPrivateReference` | 10 | private-field accessor |
| `gen` / `__closure_*` / `__cb_*` | ~40 | |

## Root-cause hypothesis

The `__uri_*` fix shows one concrete instance of the **shared-Instr-object
aliasing** hazard interacting with the late-import index-shift walker
(`shiftLateImportIndices` mutates `instr.funcIdx += delta` per occurrence; a
spread-shared `call`/`ref.func` Instr is shifted N×). The `test`/`inner`/`fn`
body-shape failures (322) may share this class (another emitter that spreads a
shared `Instr[]` containing a `call`/`ref.func`) **or** be a distinct
stack-balance / type-mismatch on a `ctx.standalone`-gated path. Triage one repro
per named function (disassemble with binaryen, read the exact validator error),
then cluster.

A defensive hardening worth evaluating: make `shiftLateImportIndices` (and the
sibling string-import shift in `index.ts`) **idempotent per Instr object** (track
a `Set<Instr>` of already-shifted call/ref.func nodes), so a shared Instr can
never be double-shifted regardless of emitter aliasing. That would neutralize the
whole bug class at the walker instead of fixing each emitter. Weigh against the
"never alias one Instr[]" convention (memory
`reference_shared_instr_object_dce_double_remap`).

## Test plan

Standalone CE → pass: `test/built-ins/String/prototype/split/**` (RegExp-arg
`__str_flatten`), plus the clustered `test`/`inner`/`fn` body-shape examples once
the shared construct is identified. Full `merge_group`.

## Resolution (2026-07-02, dev-2878)

### Re-measured the residual on current main first

The 2026-06-30 buckets had **already largely healed** on current `origin/main`
via intervening merges (#2918 native-Promise funcIdx-shift and others).
Concrete re-measurement (standalone compile + `WebAssembly.compile` validate over
a 3,500-file `built-ins` sample):

- `String/prototype/split/**`: **119/120 valid** (the `__str_flatten` bucket was
  already gone — the RegExp-arg split path validates). The `test`/`inner`/`fn`
  buckets (199/81/42 on 2026-06-30) had collapsed to a small heterogeneous tail.
- The **largest remaining coherent cluster** was a `local.tee/struct.set expected
  type eqref, found any.convert_extern of type anyref` family, surfacing as
  `__call_toString` / `__call_valueOf` (ToPrimitive dispatch) and
  `__set_member_toString` (member-write dispatch).

### Root cause — `externref → eqref` coercion produced ANYREF

`any.convert_extern` yields `anyref`, the **supertype** of `eqref`. Three sites
emitted the bare conversion and stored the result straight into an `eqref` slot
(`struct.set` / `local.set`), which the Wasm validator rejects — an invalid
binary (worst-class correctness bug). Fixed by narrowing `anyref → eqref` with a
nullable `ref.cast` to the abstract `eq` heap type (`-19` signed-LEB):

1. `src/codegen/coercion-plan.ts` — the #1917 **single coercion table** (the
   authoritative site; splits the old `externref → anyref/eqref` row so `eqref`
   narrows). This is what `fillMemberSetDispatch` uses to coerce an externref
   value into an `eqref` struct field → fixed `__set_member_*`.
2. `src/codegen/index.ts` `emitToPrimitiveMethodExports` `closure-extern` arm —
   the ToPrimitive dispatcher recovers an externref-stored method closure
   (`struct.get → any.convert_extern → local.set eqref`); narrow to the concrete
   closure struct type before the store → fixed `__call_toString` /
   `__call_valueOf`.
3. `src/codegen/type-coercion.ts` `coerceType` (fctx variant) + the
   `coercionInstrs` fallback arm — mirror the table fix for the inline-emit path.

Host (gc) mode is unaffected: this coercion only appears on the host-free
standalone/wasi path, and the change only *adds a valid narrowing cast* — a bare
`anyref`-into-`eqref` store was never valid in any mode, so there is no
valid-before case to regress.

### Measured effect

3,500-file `built-ins` standalone sample: invalid-Wasm **32 → 26** — the entire
`__call_toString`(5) / `__call_valueOf`(1) / `__set_member_toString`(1) family is
eliminated, **no new invalid functions**. Host (gc) sample unchanged (6 invalid,
all pre-existing heterogeneous `test`/`__cb_0`, none eqref-family).

### Residual (out of scope — candidate follow-on)

A small **heterogeneous** tail remains (not a single mechanism, not the
`eqref`/funcIdx-shift class): `test` (~15/sample, e.g. String/concat
`call[0] expected (ref null …)`, RegExp/test, TypedArray resizable-buffer
`array.get/array.set` type-mismatch) and a few `__closure_*` (species-poisoned
Array, for-await close, Proxy tco-realm) + `__cb_0`. Each is a distinct
codegen bug warranting its own triage; recommend a follow-on umbrella'd under
#2860 if the counts justify it.

### Tests

`tests/issue-2878-externref-eqref-narrow.test.ts` — deterministic unit assertions
that `coercionPlan` / `coercionInstrs` narrow `externref → eqref` (and leave
`externref → anyref` unchanged), plus standalone compile-and-validate of
ToPrimitive / dynamic-member shapes.
