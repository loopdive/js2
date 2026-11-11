---
id: 7322
title: "A class field write to a captured local is lost; `[n = 5] = []` assigns NaN"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7291, 7300]
---

# A class field write to a captured local is lost; `[n = 5] = []` assigns NaN

Found by the fresh-context reviews of PR #7168 (#7291 step 3). Both bugs
reproduce with the string-builder presize disabled, and on main `5a12d999`,
so they are unrelated to #7291. Each source is a `.ts` file with `test()`
exported. Measured 2026-11-07 on gc, standalone and wasi.

## 1. A class field initializer's write to a captured local is lost

```ts
export function test(): number { let m = 2; class K { x = (m = 5); } new K(); return m; }
```

- gc, standalone, wasi: `2`. JS gives `5`.
- The field initializer assigns the enclosing function's `m`. That write
  does not reach the binding `test` reads, which suggests the initializer
  writes a copy rather than the shared ref cell.

## 2. A destructuring default assigns `NaN` instead of the default

```ts
export function test(): number { let n = 1; [n = 5] = []; return n; }
function f(n: number): number { [n = 5] = []; return n; }   // f(1)
```

- gc, standalone, wasi: `NaN` for both. JS gives `5`.
- The review's variant read back `1`, so the result depends on the shape.
  Either way the default is not applied when the element is `undefined`.

## Acceptance

- Both return the JS value on gc, standalone and wasi.
- A regression test covers each shape: a local and a parameter for item 2,
  and a static block next to the field for item 1.
