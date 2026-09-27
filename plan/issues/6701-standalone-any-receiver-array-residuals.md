---
id: 6701
title: "standalone: remaining `any`-receiver Array gaps — `splice` answers null, `[].slice.call(arguments, k)` is empty, `Math.max.apply(null, arr)` is -Infinity"
status: ready
sprint: current
created: 2026-09-27
updated: 2026-09-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6683, 6447, 2717]
---

# #6701 — standalone: remaining `any`-receiver Array gaps

## Problem

Found while fixing [#6683](./6683-standalone-any-array-slice-returns-null.md)
(which served `slice`/`at`/`reverse` on an `any` receiver). Measured
2026-09-26 on the #6683 branch, `--target standalone`, zero imports:

```js
function id(v) { return v; }
id([1, 2, 3]).splice(0, 2);                          // null      (expected [1, 2])
function f() { return [].slice.call(arguments, 1); }
f(1, 2, 3).length;                                    // 0         (expected 2)
Math.max.apply(null, [3, 9, 1]);                      // -Infinity (expected 9)
```

- `splice` is the last pure-ish producer with no `$__vec_base` arm in the
  closed-method dispatcher (`dyn-array-producers.ts`); it is pinned as the
  residual in `tests/issue-6447-standalone-dynamic-array-producers.test.ts`.
  It mutates length, so it needs a shrink/grow primitive on the array-like
  substrate, not only `__extern_set`.
- `[].slice.call(arguments, k)` does not reach `__arrprod_slice`; the
  `.call` form on an `arguments` object answers an empty array.
- `Math.max.apply(null, arr)` folds nothing — the variadic Math closure is not
  fed the spread array through `.apply`.

## Acceptance

- The three rows answer the Node values in `--target standalone`, no new host
  import; remove the `splice` pin in the #6447 test.
