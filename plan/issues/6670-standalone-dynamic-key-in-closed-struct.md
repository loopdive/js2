---
id: 6670
title: "standalone: `key in obj` with a runtime key and a closed-struct receiver folded false and left the key on the stack (styled-components `De` invalid)"
status: done
sprint: current
created: 2026-09-24
completed: 2026-09-24
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
language_feature: in-operator
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6669, 1444, 2741, 5383]
---

# #6670 — standalone dynamic-key `in` on a closed struct

## Problem

Once #6669 fixed `re`, the styled-components standalone binary failed
validation in the next function, `De` (its unitless-CSS-property helper):

```js
const Te = { animationIterationCount: 1, … };
function De(e, t) { return … "number" != typeof t || 0 === t || e in Te || e.startsWith("--") ? … }
```

```
[wasm-validator error in function De] block with value and last element with value must match types
```

Single-file repro: `const Te={a:1}; function De(e){ return e.startsWith("-") || e in Te }`
is invalid, and `function De(e){ return (e in Te) ? 1 : 2 }` validates but
answers `false` for every present key.

## Root cause

`compileInOperator`'s "dynamic key with known struct fields" arm compiled the
key and only THEN looked for a string-equality helper (`__str_eq` /
`string_equals` / `wasm:js-string.equals`). Standalone has none of them, so the
arm fell through with the key still on the stack; the generic arm below
compiled both operands again and folded `i32.const 0`. The stray value was
either absorbed (wrong answer) or made the enclosing block ill-typed.

## Implementation Plan (executed)

`src/codegen/binary-ops-in.ts`:

- Resolve the equality helper BEFORE compiling the key; only compile it when
  the field-comparison loop will actually run.
- Standalone/WASI with no helper: route to `emitRuntimeExternHas` — the
  existing externref arm's `__extern_has` emission, extracted into a helper and
  shared by both sites. The Wasm-native `__extern_has` reads a closed struct's
  own fields. No new host import (standalone's `__extern_has` is Wasm-native).
- JS-host keeps its helper-backed field comparison byte-for-byte.

## Resolution

- `tests/issue-6670-standalone-dynamic-key-in-struct.test.ts`: 2 tests.
  Parent 0/2 (`0` instead of `110`; invalid module), fix 2/2.
- Pre-existing and unchanged: a dynamic key naming an `Object.prototype`
  member (`"toString"`) still answers `false` on a closed struct in standalone
  (the static-key path has the #4491 fixed-name set; the dynamic path does
  not). Not needed by styled-components.
