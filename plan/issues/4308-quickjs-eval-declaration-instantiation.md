---
id: 4308
title: "EvalDeclarationInstantiation + Annex B B.3.3 for the QuickJS eval engine — the bucket that dominates the remaining 256 eval-code failures"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4238, 4242, 4245, 4305, 4307]
blocked_by: [4245]
# id 4308 reserved via claim-issue.mjs --allocate on 2026-08-09 AFTER
# fast-forwarding the fork's main to upstream — the allocator resolves "main"
# against `origin` (the FORK here), so a stale fork mints ids already used
# upstream (it handed out 4262/4264/4265, all of which exist on main). See
# #4305's frontmatter for the full account. Open-PR scan DEGRADED (no gh in
# this container); id verified against upstream main + the assignment ref, with
# the required check:issue-ids gate as the backstop.
---

# #4308 — EvalDeclarationInstantiation + Annex B B.3.3 under the QuickJS engine

## Why this issue exists (measured, not assumed)

The QuickJS eval engine (#4238) plus the inward membrane (#4245 slice 1) took
the scoped `language/eval-code/` set from **442 → 560 / 816**. The interpreter
scores **779 / 816** on the same set, same container, same day.

The gap is now **one dominant bucket**: `EvalDeclarationInstantiation` and the
Annex B B.3.3 block-function families. Every other enumerated residual is
small or measured at zero:

| bucket | status after #4245 slice 1 |
| --- | --- |
| compiled callables can't cross inward | **CLEARED** (was 230, now 0) |
| var-env fidelity / B.3.3 | **dominates the remaining 256** |
| `new.target` / `super` in eval | 0 relative to the interpreter (both fail the same 10) |
| mapped-`arguments` | measured **0** — the predicted failures do not occur |
| completion values | 21/21 on both engines |
| strict write-back + TDZ | ~5 quickjs-only |

So this issue is the last large lever between the QuickJS engine and parity,
and #4242's default flip stays blocked until it moves.

**Do not trust the pre-membrane numbers.** The 126-fail / 102-quickjs-only
count for var-env fidelity was measured *before* the membrane landed and the
composition of the 256 has shifted. **Re-bucket first** (see below).

## The problem

Under the quickjs engine a direct eval currently snapshots caller bindings onto
a plain object `S` and evaluates `with (S) { … }` (sloppy) or a block-scoped
`const` preamble (strict), writing changed primitives back into the live cells
afterwards (#4238 slice 3). That approximates scope *reads and writes*; it does
**not** implement EvalDeclarationInstantiation:

- `var`s created by eval'd code are not hoisted into the **caller's** varEnv
  with correct visibility and lifetime.
- Annex B **B.3.3** block-level function semantics (the
  `annexB/language/eval-code/**` families) are not modelled.
- Redeclaration checks (`var-env-*`) do not run against the caller's
  environment.

## Scope

1. **Re-bucket the current 256 failures first**, using the tooling that already
   landed: `scripts/eval-engine-parity.mjs` (#4242 P1-S1) plus the runner's
   own jsonl. Produce the real breakdown *post*-membrane before designing
   anything, and record it here. The design must follow the data, not the
   pre-membrane estimate.
2. Design and implement EvalDeclarationInstantiation for this engine:
   var hoisting into the caller varEnv via the existing cell/activation-pool
   plumbing, B.3.3 block-function semantics, redeclaration checks.
3. Measure again and record the delta against 560/816.

## Hard constraints (carried from the whole workstream)

- Flag-gated only: default path (no flag / `interpreter`) **byte-identical**;
  quickjs code loaded only inside the flag branch.
- The 4-import `js2wasm:runtime-eval` seam ABI stays **FROZEN**.
- Zero JS behind the seam beyond the WASI stub; wasm-to-wasm binding only.
- **`src/interp/`, acorn, and the IR substrate the interpreter needs must NOT
  be deleted or degraded** — standing project-lead directive; the interpreter
  stays selectable behind `JS2WASM_EVAL_ENGINE=interpreter` indefinitely.
- Borrow discipline on every handle; primitive-only filter on every write-back
  path (the delayed-realm-corruption class, #4238 slice 2).

## Traps this workstream has already paid for — do not re-learn them

1. A **literal** eval argument is constant-folded by `tryStaticEvalInline` and
   never reaches the provider. Compose every eval source through a runtime loop.
2. `40+2 === 42` proves nothing about which engine ran — assert via the in-band
   `__js2wasm_eval_engine` marker where that matters.
3. Non-primitive write-back clobbers the memoized `eval`/`Function` markers and
   the damage appears on a **LATER** eval. Test a second and third evaluation.
4. Name-based lowerings can stop firing and fall back to a stub that answers
   `undefined` **with green tests**. Prove liveness by poisoning the stub
   (#4245 slice 1 did exactly this).
5. **#4305** (open): a succeeding direct eval followed by a throwing one with an
   `instanceof` catch traps with `RuntimeError: illegal cast` — caller-side
   codegen, engine-independent. It will appear in eval-heavy runs; it is not
   this issue's bug, and it pollutes the `unattributed` bucket of #4242's gate.

## Acceptance criteria

- [ ] Post-membrane re-bucketing of the 256 recorded here, with counts.
- [ ] EvalDeclarationInstantiation implemented to the level the data justifies;
      whatever is deliberately not implemented is enumerated as a residual with
      its measured file count.
- [ ] Measured `language/eval-code/` delta recorded against 560/816, plus
      confirmation the interpreter tier is unchanged (779/816).
- [ ] Default-path suites green with no flag set; equivalence suite green if
      any `src/` file is touched.
- [ ] No `src/interp/` deletion or degradation; diff audited.

## Implementation Plan

(To be written by architect — re-bucket first, then design against the real
composition of the remaining failures.)
