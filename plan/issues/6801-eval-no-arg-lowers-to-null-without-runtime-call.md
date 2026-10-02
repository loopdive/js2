---
id: 6801
title: "codegen: a no-argument `eval()` lowers to `ref.null extern` (JS `null`) with no runtime import — JS returns `undefined`"
status: ready
sprint: Backlog
created: 2026-10-01
updated: 2026-10-01
priority: low
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen
language_feature: eval
goal: core-semantics
related: [6779, 1006, 1163]
requested_by: ttraenkler/claude-review
origin: "found by the #6779 implementation (2026-10-01): tests/issue-1006.test.ts case 7 fails identically on main under every eval policy"
---

# #6801 — `eval()` with no argument is a compile-time `null`

## Problem

```ts
export function run(): string {
  const r = (eval as any)();
  return JSON.stringify([r === undefined, typeof r, r]);
}
```

| lane | result |
|---|---|
| wasm (JS host, 2026-10-01, `9d977a7e`) | `[false,"object",null]` |
| JS | `[true,"undefined",null]` |

The compiler lowers a zero-argument `eval()` call to `ref.null extern` and
emits **no** runtime-eval import for it, so the policy machinery of #6779
never sees the call. §19.2.1 step 1: if `x` is absent, `eval()` returns
`undefined`. Measured by dev-6779 with a file-copy A/B of `src/runtime.ts`,
`src/runtime-eval.ts`, `src/runtime/dynamic-function-import.ts` and the test:
the failure is identical on `origin/main`, so it is independent of the policy
change.

## Correction

In the direct-`eval` call lowering (grep `"eval"` in the call-expression
dispatch under `src/codegen/expressions/` — the site that folds literal
arguments since #1163), treat an empty argument list as the constant
`undefined` (the `undefined` sentinel the surrounding expression type expects),
not `ref.null`. No runtime import is needed: the spec result is a constant.

## Acceptance

- The probe returns `[true,"undefined",null]` on the JS-host lane and on
  `target: "standalone"`.
- `tests/issue-1006.test.ts` passes in full (its seventh case is this bug).
