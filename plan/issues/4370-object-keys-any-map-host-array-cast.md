---
id: 4370
title: "codegen: materialize externref array receivers for Array.prototype.map"
status: in-progress
sprint: current
created: 2026-08-11
updated: 2026-08-11
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays
goal: dogfood
related: [3996, 4301]
loc-budget-allow:
  - src/codegen/array-methods.ts
func-budget-allow:
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/array-methods.ts::compileArrayMap
---

# codegen: materialize externref array receivers for Array.prototype.map

## Problem

The JS-host `Object.keys(any)` path returns a real JavaScript array as
`externref`. TypeScript still describes that expression as `string[]`, so
`compileArrayMethodCall` selects the native WasmGC array-map loop. The receiver
probe correctly records `receiverIsExternref`, but the `map` arm does not pass
that fact to `setupArrayLoop`. The loop therefore emits an unconditional
`ref.cast` from the host array to the compiler's native vec and traps with
`RuntimeError: illegal cast` before invoking the callback.

Minimal reproducer:

```ts
export function runCase() {
  const method = "GET";
  const routes: any = { GET: { a: 1, b: 2 } };
  return Object.keys(routes[method]).map((key) => key).length;
}
```

This is Hono 4.12.16's `RegExpRouter.#buildMatcher` shape. After #4301 fixes
the preceding class-expression private receiver mismatch, Hono compiles and
validates but traps in the callback containing
`Object.keys(r[method]).map(...)`.

## Ownership

The externref-to-vec materialization already exists in `setupArrayLoop` and was
introduced with the Redux work recorded by #3996. `filter` and `forEach` thread
the receiver flag into that helper; `map` is the missing sibling. Issue #3996
does not describe or own this residual, so #4370 owns the narrow map routing
gap rather than reopening the unrelated local-index work.

## Acceptance criteria

- `Object.keys(any).map(...)` materializes the externref receiver once instead
  of casting the host array directly to a WasmGC vec.
- A runtime differential covers the dynamic computed-key reducer in both
  JS-host and standalone modes, including mapped values rather than only
  `.length`.
- Existing native-vec `map`, `filter`, and `forEach` paths remain green.
- The pinned Hono workload advances past the `__closure_156` illegal cast; any
  next independent failure is reported separately.
- Typecheck, IR-fallback, LOC, and function-budget gates pass.

## Implementation result

`compileArrayMethodCall` now threads the probed `receiverIsExternref` fact into
`compileArrayMap`, which delegates to the existing one-time
externref-to-native-vec materialization in `setupArrayLoop`. Runtime
differentials cover both the minimized computed-key case and Hono's exact
mapped `[path, route]` tuple shape in JS-host and zero-import standalone modes.

The pinned Hono workload no longer traps in `__closure_156`. It compiles and
validates, then advances to the independent router-state failure
`No active router has been determined yet.`
