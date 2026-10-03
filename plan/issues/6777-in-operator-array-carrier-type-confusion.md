---
id: 6777
title: "codegen: `in` on array carriers — type-confused lowering (invalid module on `any[]`), wrong answers on holes/`delete`, non-boolean result"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: in-operator
goal: core-semantics
related: [6776, 2130, 2741, 3280, 1991]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C1/H5"
---

# #6777 — `in` on arrays is wrong three ways, and one of them emits an invalid module

## Problem

Probe results (JS-host lane, `compile()` + `buildImports`, diffed against Node):

| source | wasm | JS |
|---|---|---|
| `const arr: any[] = [1,2,3]; arr[5] = 9; [2 in arr]` | **invalid module** (`struct.get[0] expected (ref null 2), found (ref null 4)`) — `success: true` | `[true]` |
| `const arr: number[] = [1,2,3]; delete arr[0]; 1 in arr` | `false` | `true` |
| `const arr: any[] = [1,2,3]; delete arr[0]; 0 in arr` | `true` | `false` |
| `[2 in arr]` on a dense `number[]` | `[1]` / `[0]` (i32, not boolean) | `[true]` / `[false]` |

## Root cause

`src/codegen/binary-ops-in.ts`:

- `:383-394` detects the vec carrier by **struct-name prefix**, then the typed
  arm at `:482` emits `struct.get` against a struct type that does not match the
  local's actual carrier type when the array is `any[]` (the `any` vec and the
  typed vec have different struct indices). That is the invalid module.
- `:482-490` answers `idx < length` for the dense case — a hole created by
  `delete` (#2130 made `delete arr[i]` work) still reads as present, and the
  comparison result is left as i32 instead of going through the boolean box.
- The comment at `:490` already names the `__extern_has_idx` chokepoint that
  handles holes correctly; the typed fast path bypasses it.

## Correction

1. Route every `in` whose RHS is an array carrier (typed vec, `any` vec,
   sparse-capable vec) through one helper that consults the carrier's hole
   representation (whatever `delete arr[i]` writes) and returns a proper
   boolean.
2. Keep a fast path only where the carrier is statically known dense AND the
   key is a statically-in-range integer; otherwise call the helper.
3. Resolve the carrier struct type from the compiled receiver's `ValType`,
   never from a name prefix.

## Acceptance

- All four rows above match Node.
- Regression file `tests/issue-6777-in-array-carrier.test.ts` covering `any[]`,
  `number[]`, `string[]`, holes via `delete`, out-of-range index, negative
  index, string keys (`"length" in arr`, `"0" in arr`), and the result being a
  real boolean (`=== true`).
- With #6776 landed, the first row is a compile error until fixed; after this
  issue it is `[true]`.
