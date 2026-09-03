---
id: 5288
title: "`typeof x` on a numerically-used parameter emits an INVALID module — f64 narrowing drops the undefined arm"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
loc-budget-allow:
  - src/codegen/declarations/param-return-inference.ts
---

## Problem

`inferParamTypeFromBody` narrows an implicit-`any` parameter to `f64` as soon
as the body uses it numerically, and treats only `??` / `??=` as observing the
distinction an f64 slot cannot carry:

```ts
// f64 cannot preserve the distinction this operation observes:
// unboxing `undefined` yields NaN, but `undefined ?? fallback` must
// select the fallback while `NaN ?? fallback` must not.
```

`typeof` observes exactly the same distinction, one operator over. An omitted
argument pads the f64 slot with `0`, so `typeof size` answers `"number"` where
the program requires `"undefined"`. And because the `typeof` lowering takes an
**externref**, the narrowed parameter does not merely answer wrongly — it emits
an **invalid module**:

```
WebAssembly.instantiate(): Compiling function "f" failed:
  call[0] expected type externref, found local.get of type f64
```

Six-line repro (webpack's `formatSize` shape):

```js
// mod.js
export function f(size) {
  if (typeof size !== "number") return "unknown";
  if (size <= 0) return "zero";      // ← the numeric use that narrowed it
  return "n";
}
// entry.ts
import { f } from "./mod.js";
f();     // instantiation fails; before the numeric arm existed it answered "unknown"
```

The **arrow** spelling of the same body was already correct — it stays on the
dynamic carrier — so the declaration form was the odd one out.

## Fix

Treat `typeof <param>` as a nullish-sensitive use, exactly as `??` already is.
One arm in `inferParamTypeFromBody`'s visitor; the narrowing is unchanged for a
parameter with no `typeof` use.

## Measured

- `tests/typeof-param-narrowing.test.ts`: 3 of its 5 cases fail on the parent
  commit (two of them by failing to instantiate at all); all 5 pass with the
  fix. The two that already passed are the guards — an argument that IS
  supplied still takes the numeric arms, and a purely numeric parameter stays
  narrowed.
- Upstream npm suites re-run after the change: webpack 15/16, three 17/18,
  clsx 32/32, cookie 63740/63740, lodash 50/62, redux 60/82 — all identical to
  the pre-change baseline. No package moved, and none regressed.

## Not fixed here (measured, adjacent)

The same "optional parameter narrowed to a scalar" family has two more slices
that this change does not reach, both reproduced in six lines:

1. **`export default f` + JSDoc-optional param** answers `"zero"` for an
   omitted argument. Exporting the identical function BY NAME is correct, and
   so is the same default export without the JSDoc — so
   `parameterMayBeOmitted` (which already names webpack's `formatSize` as its
   witness) is not consulted on the default-export path. This is why webpack's
   real `formatSize()` still answers `"0 bytes"`.
2. **`@param {number} [size]`** (the bracketed JSDoc spelling) on an arrow that
   is lifted to a closure emits the same invalid module in `__closure_0`; the
   `{number=}` spelling of the same parameter is fine.
