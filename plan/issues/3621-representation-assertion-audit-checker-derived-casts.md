---
id: 3621
title: "Audit: representation assertions derived from checker queries — the systemic form of #3610/#3620 (`ref.cast` justified by a static type)"
status: in-progress
assignee: ttraenkler/opus-3621
sprint: current
priority: high
horizon: l
feasibility: hard
goal: standalone-gap
related: [3610, 3620, 3062]
created: 2026-07-25
loc-budget-allow:
  - src/codegen/typeof-delete.ts
# +3 lines at each of the two clearField construction sites (the guardClearField
# call wrapping an existing array literal). The guard BODY was extracted into a
# module-level helper precisely to keep this function from growing further.
func-budget-allow:
  - src/codegen/typeof-delete.ts::compileDeleteExpression
---

## The invariant under audit

> **A `ref.cast` is a claim that the value's runtime representation is known.
> A static type is not that evidence.**

Where the checker's belief comes from a _declaration_ rather than from the
_value_, an unconditional `ref.cast` / `struct.get` / `struct.set` built on it
can meet a reachable value that violates it — and the result is an
**uncatchable trap** that aborts the whole module.

Four confirmed instances, in four different subsystems:

| #                      | how the checker was wrong                                                                                                                        | symptom                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| #3062                  | `lib.d.ts` types `X.prototype` as an instance                                                                                                    | hand-patched 2 members                                           |
| #3610                  | same, generalised                                                                                                                                | `illegal cast` / `null reference` on builtin prototype receivers |
| #3620                  | tuple param type inferred **from the default initializer**, while the widened `externref` boundary meant the value was always a plain vec        | `illegal cast` in class generator methods                        |
| **#3621** (this issue) | **`this` in a REFLECTIVELY-invoked accessor** — the checker types it from the object literal's shape, but the accessor can be called on anything | `illegal cast` in `delete this.x`                                |

## Methodology, and an honest correction to the audit's own scope

The assignment scoped this to the **68 `getSymbol()?.name` sites** in
`src/codegen/`. Measuring first: **that grep is a proxy, and it under-covers.**

- #3620's defect site is `resolveWasmType(checker.getTypeAtLocation(param))`.
- #3621's defect site is `resolveStructName(checker.getTypeAtLocation(recv))`.

**Neither is a `getSymbol()?.name` site.** So an audit bounded by that grep
would have missed both of the instances we already proved. The real family is
_a representation decision derived from any checker query_. Broadening to the
five entry points that produce one:

| entry point          |   sites | RAW-ASSERT | GUARDED | NO-ASSERT |
| -------------------- | ------: | ---------: | ------: | --------: |
| `resolveWasmType(`   |     232 |         26 |       3 |       203 |
| `getSymbol()?.name`  |      70 |          4 |       4 |        62 |
| `resolveStructName(` |      43 |          5 |       2 |        36 |
| `declaredNameOf(`    |       9 |          0 |       0 |         9 |
| `builtinReceiverOf(` |       6 |          0 |       0 |         6 |
| **total**            | **360** |     **35** |   **9** |   **316** |

("RAW-ASSERT" = a `ref.cast`/`struct.get`/`struct.set` appears in the site's
scope with no `ref.test` in scope. `getSymbol()?.name` is 70 rather than the
assignment's 68 because #3610's own fix added 2 — those are the remedy, not the
risk.)

### Limits of the mechanical pass — do not read these as verdicts

1. **`NO-ASSERT` does NOT mean safe.** The window is 60 lines within one
   function. #3620 is the counter-example: `class-bodies.ts` computed the
   param type and the trapping `ref.cast` was emitted in a _different module_
   (`generators-native.ts`), from a value handed across a function boundary.
   Cross-module data flow is invisible to this triage.
2. **`RAW-ASSERT` over-reports after a fix that extracts the guard.** This
   issue's own fix routes the guard through a helper (`guardClearField`), so
   the `ref.test` is no longer lexically in scope and `typeof-delete.ts:490`
   and `:590` still report RAW-ASSERT. They are guarded.
3. **`RAW-ASSERT` also over-reports on STATIC guards.** A site that checks
   `recvType.typeIdx === expectedTypeIdx` before its `struct.get` is exactly as
   sound as a `ref.test`, but carries no `ref.test` for the regex to find.
4. The triage is therefore a **prioritised reading list**, not a classification.
   The classification below is hand-verified only where marked.

### Hand-verified: three of four `getSymbol()?.name` RAW-ASSERTs are safe, ONE IS LIVE

> **Correction to this document's own first draft.** It originally listed all
> four as safe, with `regexp-standalone.ts:2853` marked "safe — receiver is
> materialised by the same lowering that types it". **That verdict was written
> without reading the site, and it is wrong.** An unverified entry in a table
> headed "hand-verified" is worse than no entry, because it stops the next
> person from looking. The corrected row is below. The same failure mode this
> issue exists to catch — asserting something on the strength of a plausible
> story rather than evidence.

| site                                                                                                          | verdict              | why                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `property-access-dispatch.ts:1090` (`TextEncoderEncodeIntoResult`)                                            | **safe**             | `struct.get` runs only under a STATIC `recvType.typeIdx === resultTypeIdx` check; otherwise it drops and returns `f64 0`. Limitation 3.                                                                                                                                                                                                                             |
| `property-access-dispatch.ts:759` (buffer byte attrs)                                                         | **safe**             | the downstream cast IS `ref.test`-guarded (~line 915, with a `0` fallback) — outside the 60-line window. Also carries #3062's `.prototype` null-out and now sits behind #3610's gate. Limitation 1.                                                                                                                                                                 |
| `expressions/call-builtin-static.ts:1783` (`Generator`)                                                       | **safe**             | compiles + **drops** the argument and returns a cached singleton; no assertion on the value at all. The `struct` match came from the _next_ arm (line 1793), counted separately.                                                                                                                                                                                    |
| `regexp-standalone.ts:2853` (`RegExpExecArray` / `RegExpMatchArray` → `.index`/`.input`/`.groups`/`.indices`) | **LIVE — unguarded** | keys on `nonNull.getSymbol()?.name`, then at lines 2869-2877 does `any.convert_extern` + **unconditional `ref.cast` to `matchVecIdx`** for an `externref` receiver (and a bare `ref.cast` for a mismatched `ref`). No `ref.test`, no fallback. A value the checker types `RegExpMatchArray` but which this standalone backend did not produce traps `illegal cast`. |

**Suspected connection to an already-measured symptom:** 2 of the 3 rows that
still trapped after slice 1 are `built-ins/RegExp/match-indices/*`, and
`.indices` is handled by exactly this site. Not yet confirmed — the census
category for those rows is `null_deref`, not `illegal_cast`, so it may be a
different assertion in the same lowering. **Confirm before fixing** (the whole
point of this issue is not to assert without evidence).

Net: **the `getSymbol()?.name` scope is not empty after all — it holds one live
RAW-ASSERT.** But it remains a poor proxy: both _proven_ defects (#3620, #3621)
came from `resolveWasmType(` / `resolveStructName(`, and #3620's cast was
emitted a module away from its decision. Future effort should go to the
`resolveWasmType(` / `resolveStructName(` RAW-ASSERTs and, above all, to sites
where the decision and the cast are **separated by a function boundary** —
which no lexical triage can find.

## Slice 1 (this PR) — `delete obj.prop` on a reflectively-bound receiver

### Root cause (read off the emitted WAT, engine-confirmed frame)

Test: `language/expressions/compound-assignment/S11.13.2_A5.10_T3.js`

```js
var innerScope = {
  get x() {
    delete this.x;
    return 2;
  },
};
with (outerScope) {
  with (innerScope) {
    x ^= 3;
  }
}
```

The raw V8 wasm stack (not the runner's enrichment) puts the trap in the getter
closure:

```
RuntimeError: illegal cast
    at __closure_33 ... at __call_fn_method_0 ... at __call_accessor_get
    at __extern_get ... at __module_init
```

and `$__closure_33`'s body is:

```wat
call 118                       ;; __delete_property(this, "x") -> i32
(if (then
  local.get 2                  ;; the receiver, an externref
  any.convert_extern
  ref.cast null (ref null 70)  ;; <-- the object literal's shape struct
  f64.const NaN
  struct.set 70 0))            ;; poison the field
```

`compileDeleteExpression` resolves the struct from
`resolveStructName(checker.getTypeAtLocation(inner.expression))` — the object
literal's _declared_ shape. But this accessor is invoked reflectively through
`__call_accessor_get`, so `this` is bound to whatever it was called on, which
is not that struct. The cast traps.

### Fix

`guardClearField` (`src/codegen/typeof-delete.ts`) wraps the field-clearing
`struct.set` in a `ref.test` **when the static type does not already prove the
receiver is that struct**. A statically-exact `ref`/`ref_null` receiver emits
byte-identical code to before, so the common case is untouched.

Not compile-time decidable (whether `this` is the struct depends on the call),
so this is the **runtime** arm of the remedy, not #3610's compile-time arm.
Nothing is lost on the miss path: the `__delete_property` sidecar call has
already done the semantically meaningful part of the delete; `clearField` only
resets a shape-struct field that this receiver does not have.

### Measured reach — honest, and modest

All 33 rows whose frame chain contains `__call_accessor_get`, run before/after:

|                            | before |  after |
| -------------------------- | -----: | -----: |
| uncatchable trap           |     33 |  **3** |
| honest (catchable) failure |      0 | **30** |
| pass                       |      0 |  **0** |

- **30 rows stop trapping** — every `illegal_cast` row (compound-assignment ×22,
  postfix/prefix increment/decrement ×8).
- **0 rows flip to pass, and that is the correct outcome**: the trap was
  masking a genuine feature gap (`with`-scope PutValue write-back), so the
  honest result is a failure. Reported separately per the brief — _catchable
  beats fatal_ under the crash-free goal (a trap poisons every later assertion
  in the file; a catchable failure does not), but this slice buys **no
  conformance points**.
- The 3 still-trapping rows are `null_deref [in toString()]`
  (RegExp `match-indices` ×2, `DisposableStack.prototype.move` ×1) — a
  different root cause that merely shares the `__call_accessor_get` frame
  ancestor. Not this fix's subject.

## Remaining RAW-ASSERT reading list (not yet hand-verified)

Highest-suspicion first, by whether the receiver can be reflectively bound or
`any`-typed:

- `property-access-dispatch.ts:759`, `:1090`, `:3051`, `:3402`, `:3414`
- `property-access.ts:4528`, `:4545`
- `expressions/unary-updates.ts:1695`, `expressions/operator-assignment.ts:332`, `:438`, `:2357`
- `expressions/call-builtin-static.ts:774`, `:1783`, `:1793`
- `statements/for-of-destructuring.ts:323`, `:487`, `:671`; `statements/loops.ts:1099`, `:1100`
- `expressions/new-super.ts:775`, `:896`, `:921`
- `destructuring-params.ts:1897`, `:1899`; `closures/arrow-phases.ts:529`; `closures.ts:1015`
- `async-cps.ts:2303`, `object-ops.ts:533`, `regexp-standalone.ts:2853`,
  `expressions/calls.ts:4241`, `expressions/calls-closures.ts:863`, `:867`,
  `typeof-delete.ts:1682`

## Acceptance criteria

- [x] The invariant and its four instances are stated in one place.
- [x] The audit's own scope is measured, not assumed — and the assignment's
      68-site bound is corrected where it under-covers.
- [x] Slice 1: `delete this.x` on a reflectively-bound receiver no longer traps.
- [ ] Remaining RAW-ASSERT sites hand-verified and fixed or marked safe.
