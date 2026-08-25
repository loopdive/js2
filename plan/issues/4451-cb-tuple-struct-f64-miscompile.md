---
id: 4451
title: "Sibling invalid-module miscompile: callback tuple slot typed struct-ref, element read lowered f64 (boundary-policy.ts __cb_0)"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
loc-budget-allow:
  - src/codegen/type-coercion.ts
---

# #4451 — `__cb_0` miscompile: `struct.new[1]` expects struct ref, gets `if` of f64

Found by the #4420 self-hosting baseline sweep and confirmed a **sibling**
defect, NOT a second symptom of #4420's Phase-3 vote bug — it still reproduces
after that fix:

```
compileFiles("src/boundary-policy.ts") → success: true, 60,352 bytes
WebAssembly.Module(): Compiling function #47:"__cb_0" failed:
  struct.new[1] expected type (ref null 26), found if of type f64 @+28816
```

Cheap WAT localization from the #4420 session (starting point, re-verify):
`$__cb_0` builds a `$__tuple_0 (struct (field $_0 externref) (field $_1
(ref null $StructTypeDef)))` whose second element is a **bounds-guarded array
read** lowered as `(if (result f64) … (else NaN))` — the element type was
decided f64 while the tuple slot expects a struct ref. The `(else NaN)` arm is
the tell: this is the null/undefined-in-f64-context lowering (`f64.const NaN`,
see CLAUDE.md Type Coercion) applied to an element whose static type is an
object.

## Implementation Plan (Fable, 2026-08-15)

Same discipline as #4420 Part 2 — procedure, not guessing:

1. **Base**: this branch stacks on `claude/compiler-speedup-xqgm1z` (PR #4559)
   because the repro/AC uses the `validate: true` option and
   `validateEmittedBinary` landed there. Do not enqueue before #4559 merges
   (predecessor-stacking rule); re-merge its branch if it changes.
2. **Localize precisely**: compile `src/boundary-policy.ts` with WAT emission,
   find `$__cb_0`, identify the source construct — `__cb_N` functions are
   compiler-generated callback wrappers (grep `__cb_` and
   `__make_getter_callback`/callback-wrapper emission in `src/codegen/` to map
   wrapper index → source callback). Locate which callback in
   `boundary-policy.ts` (likely an arrow function passed to a higher-order
   helper) contains the guarded array read.
3. **Minimize** into `.tmp/` (a callback + array-of-objects + bounds-guarded
   `arr[i]` read feeding a tuple/struct construction is the suspected shape;
   `aggregatePolicy` had an IR-fallback warning — the legacy path compiled it).
   Reduce until the valid/invalid flip is isolated.
4. **Root-cause at the type-decision site**: the element-read lowering chose
   f64 (with NaN for the OOB arm) while the consumer slot is a struct ref.
   Candidates: the vec element-type resolution for the callback's parameter
   types, or the OOB-guard lowering assuming numeric element type. Fix where
   the element ValType is decided; do NOT cast at the struct.new site. Respect
   the oracle-ratchet rule (no raw `checker.*`).
5. **Regression tests** (`tests/issue-4451*.test.ts`): (a) minimized construct
   — compile with `validate: true`, assert success AND run it, asserting the
   correct value flows through the callback; (b) AC —
   `compileFiles("src/boundary-policy.ts", { validate: true })` asserts
   `success === true` and `WebAssembly.compile` resolves. Follow #4420's
   out-of-process probe pattern (`tests/helpers/compile-files-validate-probe.ts`
   already exists and takes a file argument — reuse it) if the in-worker heap
   cap bites; boundary-policy's graph is smaller, so try in-worker first.
6. **Collateral check**: run the #4420 test file
   (`tests/issue-4420-emitted-binary-validation.test.ts`) plus the dispatch
   suites it lists — your fix must not regress the encodeInstr repair.

## Acceptance criteria

- [x] Root cause documented in Results (exact construct + faulty type decision).
- [x] `compileFiles("src/boundary-policy.ts", { validate: true })` → success
      and engine-valid.
- [x] Minimized-construct test compiles, validates, and computes correctly.
- [x] No regression in issue-4420 tests / dispatch suites; typecheck + gates
      green.

## Results

### The construct

`__cb_0` is the host callback wrapper for the comparator in
`buildExportBoundaryPolicies` (`src/boundary-policy.ts`):

```ts
Object.entries(signatures ?? {}).sort(([left], [right]) => left.localeCompare(right));
```

`Object.entries` hands the array to the **host**, so the comparator is
dispatched through `__make_callback` and its two parameters arrive as
`externref` — while their declared type is the tuple `[string, ExportSignature]`.
`__cb_0` therefore opens with `buildTupleFromExternref`
(`src/codegen/type-coercion.ts`), which emits a runtime `ref.test` chain over
**every** known vec type and, in each arm, a bounds-guarded read of each tuple
element coerced into the matching slot.

### The faulty type decision

The element type per arm was correct; the **element→slot coercion matrix was
incomplete**. In the `__vec_f64` arm the elements read as `f64`, and the matrix
(`buildTupleFromExternref`, the `if/else if` chain around the old L1411–1445) had
no row for

```
f64  →  (ref null $ExportSignature)
```

nor for its mirror `ref → f64`. With no matching row the chain simply fell
through and pushed **nothing**, leaving the raw `f64` on the stack for
`struct.new`. That makes the whole **module** invalid even though the arm is
unreachable at run time — a `[string, ExportSignature]` pair is never a
`__vec_f64`. The `(else NaN)` sentinel named in the issue is the out-of-bounds
default of the guard (`defaultValueInstrs`), which is what made the stray f64
visible in the WAT; it is not itself the defect.

The downstream repair pass `fixStructNewFieldCoercion`
(`src/codegen/stack-balance.ts`) did not catch it either: it asks
`callArgCoercionInstrs`, which has no `f64 → ref` row, gets `[]` back, concludes
"no coercion needed", and emits nothing. That is why the invalid bytes survived
to the engine.

### The fix

`src/codegen/type-coercion.ts`, +34 lines, at the element-type decision site —
**not** at `struct.new`:

- Two numeric rows that were also missing and also produce ill-typed
  `struct.new`: `i32 → f64` (`f64.convert_i32_s`) and `f64 → i32`
  (`i32.trunc_sat_f64_s`).
- A terminal row for the representationally impossible pairs, via the new
  `tupleSlotIsUnreachableFrom(elem, slot)` predicate (numeric on one side, GC
  ref on the other): `drop` the element and materialize the **slot's own
  default** (`defaultValueInstrs` → `ref.null`). No instruction turns a raw
  `f64` into a GC reference, so the slot's default is the only well-typed
  answer, and it matches the convention already used by the out-of-bounds arm
  directly above and by `buildTupleFromIterableFallback`.

Deliberately **not** done: `externref ↔ i32` rows (which would have needed
`__box_number`/`__unbox_number`). They are a third hole in the same matrix, but
the boolean-slot case that would exercise them
(`Object.entries(Record<string, boolean>).sort(([l],[r]) => …)`) compiles to a
**valid** module on the unfixed compiler, so there is no repro — and adding them
grew `check:coercion-sites` vocabulary for a speculative path. With the rows
absent, those pairs now fall into the terminal default row instead of emitting
invalid bytes.

### Measurements

Repro harness: `.tmp/selfhost-repro.mts` (copied from the #4420 session) and a
`compile → WebAssembly.validate` probe; every A/B below was run by swapping the
single changed file against `git show HEAD:src/codegen/type-coercion.ts`.

| Construct | before | after |
| --- | --- | --- |
| `compileFiles("src/boundary-policy.ts")` | `success: true`, 60,352 B, **`validate: false`** (`__cb_0` `struct.new[1]`) | `success: true`, 60,370 B, **`validate: true`** |
| minimized, interface slot (`Record<string, Sig>`) | `validate: false` | `validate: true` |
| minimized, array slot (`Record<string, number[]>`) | `validate: false` | `validate: true`, `main() === "a1/10;b2/20;"` |
| `Record<string, string>` (both slots externref) | valid, `"bBaA"` | **identical** — change is byte-neutral here |
| boolean slot (`Record<string, boolean>`) | valid, `"a1b0"` | **identical** |

`tests/issue-4451-cb-tuple-struct-f64.test.ts` — 4 tests, all pass (two
validate pins, one runtime-value assertion, one out-of-process acceptance probe
on `src/boundary-policy.ts`, ~16 s).

The runtime-value assertion uses the **array**-typed slot rather than the
interface-typed one on purpose: both are invalid before the fix and valid after,
but the interface variant then trips a **separate, pre-existing** defect in the
host round-trip of a struct through `Object.entries` (`RuntimeError: illegal
cast`). That is not caused here — the same construct **without any callback**
(`for (const [name, sig] of Object.entries(sigs))`) already throws a
`WebAssembly.Exception` on the unfixed compiler. Recorded so the finding is not
lost; it needs its own issue.

### Collateral

- `tests/issue-4420-emitted-binary-validation.test.ts` — 5/5 pass.
- Dispatch/tuple-adjacent sweep: `illegal-cast-vec-tuple-648`,
  `issue-2190b-anytuple-nested`, `issue-1372-ir-destructuring-params`,
  `issue-2502-sort-externref`, `issue-2379-standalone-sort-rep`,
  `issue-1712-dynamic-dispatch`, `issue-1712-capture-closure-dispatch`,
  `issue-2664-arity-dispatch`, `generator-method-destructuring`,
  `issue-2169-destructure-native-generator` → **79 passed, 6 failed**, and the
  *identical* 6 (by name) fail on the pre-fix codegen, A/B'd by swapping the
  single changed file. Pre-existing, not caused here.
- `pnpm run typecheck` exit 0; prettier clean; biome
  `--diagnostic-level=error` clean.
- Gates green: `check:coercion-sites`, `check:func-budget`,
  `check:oracle-ratchet`, `check:any-box-sites`, `check:stack-balance`.
  `check:loc-budget` growth (`src/codegen/type-coercion.ts` +44 incl. comments)
  is granted in this file's frontmatter. `check:godfiles` fails identically
  before and after this change (`object-runtime.ts`, `array-methods.ts`,
  `native-strings.ts` — files this change does not touch), so it is pre-existing
  branch/main drift.
