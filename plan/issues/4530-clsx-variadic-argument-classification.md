---
id: 4530
title: "clsx: variadic argument classification broken — strings iterate per-character ('f o o'), numbers and object keys drop; 12/32 upstream tests fail"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: typeof, arguments, for-in
goal: npm-library-support
related: [3995, 4529, 3750]
files:
  - tests/dogfood/clsx-upstream-suite.mjs
---

# clsx: `toVal`'s typeof/iteration classification misfires on variadic args

## Problem

clsx's pinned upstream suite: **20/32 Wasm** (32/32 Node), measured
2026-08-16 on `a9b20d4c`, matching the npm-compat card. The 12 failures are
classification errors inside clsx's tiny `toVal`/loop core:

| upstream test | got | expected | reading |
| --- | --- | --- | --- |
| `strings` | `f o o` | `foo` | a **string** arg was iterated element-wise like an array |
| `strings (variadic)` | `f o o bar` | `foo bar` | same, mixed with a later arg that worked |
| `numbers` | `` (empty) | `1` | a **number** arg was dropped (typeof gate missed) |
| `numbers (variadic)` | `2` | `1 2` | first number dropped |
| `objects` | `` | `foo` | object key iteration produced nothing |
| `objects (variadic)` | `bar` | `foo bar` | first object's keys dropped |
| `arrays (no push escape)` | `` | `push` | array-like branch misrouted |
| `functions` | `hello w o r l d` | `hello world` | string after function arg re-hit the char-split |
| `exports` (×2, index+lite) | function !== function | — | default vs named export not identical |
| lite `strings` ×2 | ``/`bar` | `foo`/`foo bar` | lite's `typeof x === 'string'` gate failed |

Upstream `toVal` is: `typeof mix === 'string' || typeof mix === 'number'` →
append; else if object → `Array.isArray` ? recurse : `for (k in mix)`. The
observed set (string treated as iterable object, number failing the typeof
gate, `for..in` over an object yielding nothing) says variadic/boxed args are
misclassified — the same family as #4529's typeof-on-boxed-any, plus the
`for..in`-over-boxed-object and `Array.isArray`-on-boxed gates. The
`exports` failures are separate: `clsx` default and named export are not the
same function object after compilation.

## Reproduction

```bash
node --import tsx tests/dogfood/clsx-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Land #4529 first** (typeof on boxed any) and re-run this suite — the
   string/number rows likely flip with it; this issue then owns what
   remains. Do not duplicate the typeof fix here.
2. **Reduce the `for..in` row independently**: a function receiving a boxed
   object arg (via rest/`arguments`) whose `for (k in obj)` yields no keys.
   Cross-check #3750 (dynamic property writes dropped) and the
   `Object.keys`-on-dynamic issues (#4298) — pick the existing issue if the
   reduction matches; otherwise this issue carries it.
3. **Reduce the export-identity row**: `export default clsx; export { clsx }` —
   both bindings must resolve to one function object through the host
   bridge. Suspect: each export path mints its own wrapper closure. Fix in
   the export emission (one canonical function value per declaration),
   not in the harness.
4. **Validation gates**: clsx harness 20 → ≥30 (record exact); committed
   reductions for each fixed row; equivalence green.

## Acceptance criteria

- [ ] `clsx('foo')` compiles to `"foo"`, `clsx(1,2)` to `"1 2"`,
      `clsx({foo:true})` to `"foo"` through the dynamic-arg path.
- [ ] Default and named export are identical function values.
- [ ] clsx upstream ≥ 30/32 with any residual named in this file.
