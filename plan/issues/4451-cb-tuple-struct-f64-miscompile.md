---
id: 4451
title: "Sibling invalid-module miscompile: callback tuple slot typed struct-ref, element read lowered f64 (boundary-policy.ts __cb_0)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
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

- [ ] Root cause documented in Results (exact construct + faulty type decision).
- [ ] `compileFiles("src/boundary-policy.ts", { validate: true })` → success
      and engine-valid.
- [ ] Minimized-construct test compiles, validates, and computes correctly.
- [ ] No regression in issue-4420 tests / dispatch suites; typecheck + gates
      green.
