---
id: 908
title: "Remove redundant codegen in inlined top-level numeric loops"
status: done
assignee: dev-refactor
completed: 2026-07-17
created: 2026-04-02
updated: 2026-07-17
priority: medium
feasibility: medium
reasoning_effort: high
goal: performance
sprint: current
depends_on: [906, 907]
files:
  src/codegen/index.ts:
    modify:
      - "Eliminate dead read/drop sequences after module-global writes in top-level init code"
  src/codegen/expressions.ts:
    modify:
      - "Avoid unnecessary numeric representation churn in simple counted loops"
---
# #908 -- Remove redundant codegen in inlined top-level numeric loops

## Problem

After inlining was fixed for this example:

```ts
function squared(n) {
  return n * n;
}

let result = 0;

for (let i = 0; i < 10000; i++) {
  result += squared(10);
}

console.log(result);
```

the emitted WAT still contains avoidable overhead:

```wat
(func $__module_init
  (local $i i32)
  (local $__inline_squared_p0_1 f64)
  ...
  (block
    (loop
      local.get 0
      f64.convert_i32_s
      f64.const 10000
      f64.lt
      i32.eqz
      br_if 1
      (block
        global.get 2
        f64.const 10
        local.set 1
        local.get 1
        local.get 1
        f64.mul
        f64.add
        global.set 2
        global.get 2
        drop
      )
      ...
    )
  )
)
```

Two concrete misses remain:

- dead read/drop after assignment:
  - `global.set 2`
  - `global.get 2`
  - `drop`
- repeated `i32 -> f64` loop-condition churn:
  - `local.get 0`
  - `f64.convert_i32_s`
  - `f64.const 10000`
  - `f64.lt`

The inlining itself is now correct, but these extra instructions still leave performance on the table.

## Goal

Tighten codegen for simple top-level counted loops so the emitted Wasm does not contain obviously dead value traffic or unnecessary numeric representation churn.

## Requirements

1. Remove dead read/drop sequences after writes when the produced value is not observed
2. Prefer integer loop comparisons when the loop variable is naturally `i32`
3. Preserve correct JS numeric semantics where representation changes are actually required
4. Keep the already-correct inlining behavior for `squared(10)`
5. Add regression coverage using the example above

## Acceptance criteria

- the example above no longer emits `global.get ... ; drop` after updating `result`
- the example above uses a tighter loop condition without unnecessary `i32`/`f64` churn where the compiler can prove it is safe
- generated WAT is measurably simpler while preserving behavior


## Resolution (2026-07-17)

Requirement 1 / acceptance criterion 1 (dead read/drop) shipped: peephole
**Pattern 2b** in `src/codegen/peephole.ts` removes `global.get N; drop` — the
side-effect-free re-read + drop the tail codegen leaves for a discarded compound
assignment to a module global (`result += squared(10)` in statement position).
The preceding `global.set N` store is untouched. Coverage:
`tests/issue-908.test.ts` (direct peephole unit tests for removal / chain /
live-value preservation, plus an optimizer-off end-to-end check that no dead
`global.get; drop` remains and the value is correct).

Requirement 2 (integer loop comparison / numeric-representation churn) is a
distinct, higher-risk, type-level codegen change (proving the counter stays
integral and in i32 range, choosing an i32 bound) — not a peephole. It was
scoped out to keep this change safe and minimal and is tracked as **#3372**.
