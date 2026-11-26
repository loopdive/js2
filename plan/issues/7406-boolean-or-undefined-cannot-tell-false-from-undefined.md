---
id: 7406
title: "A `boolean | undefined` value cannot tell `false` from `undefined` (`===`, `??`, `typeof`, `String`)"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7374, 7360, 7366]
---

# #7406 — `boolean | undefined` reads `undefined` as `false`

## Problem

Found in #7374. RV7334 confirmed it is a silent wrong answer, not only a limit of `?.`. Measured on `origin/main`
ee3fcdd610 (2026-11-19). Default and `--target standalone` behave identically:

| program (`f(undefined)` and `f(false)`) | node | we answer |
| --- | --- | --- |
| `b === undefined ? 1 : 0` with `b: boolean \| undefined` | `undefined` → 1, `false` → 0 | 0, 0 |
| `b === false ? 1 : 0` | 0, 1 | 1, 1 |
| `b ?? true` | `true`, `false` | `false`, `false` |
| `typeof b === "undefined"` | 1, 0 | 0, 0 |
| `String(b)` | `"undefined"`, `"false"` | `"false"`, `"false"` |
| field `b: boolean \| undefined = undefined`, then `b === undefined` | 1 | 0 |
| optional parameter `b?: boolean`, then `b === undefined` | 1, 0 | correct |
| a local `let b: boolean \| undefined;` | 1 | correct |

## Cause

`mapTsTypeToWasm` (`src/checker/type-mapper.ts`, the union arm) strips `undefined` from the union. Because `boolean`
is `true | false`, `boolean | undefined` lowers to a bare branded i32 (`{ kind: "i32", boolean: true }`) with no
value left over for `undefined`. The `undefined` → i32 coercion then produces `0`, the same bits as `false`. An
optional parameter and an uninitialised local take a different slot path and are correct.

This is the boolean counterpart of the f64 `undefined` sentinel (#7360, #7366).

## Representation options (decision needed before implementation)

1. **An i32 sentinel.** For example `2` = `undefined` in a nullable boolean slot. Chosen in `mapTsTypeToWasm`, produced by the
   `undefined` → i32 coercion, and honoured by every boolean reader: conditions (ToBoolean must treat it as falsy),
   `===`/`!==`, `??`/`??=`, `typeof`, `String()`/boxing, and `?.` short-circuits. The slot stays cheap. The cost is that
   every reader of a branded-boolean i32 must be audited, which is the same audit the f64 sentinel needed.
2. **Lower `boolean | undefined` to externref.** No new sentinel, and every reader already handles the dynamic
   value. The costs are boxing on each write and a representation change at every ABI boundary where the type is
   used: parameters, fields, returns.
3. **A separate presence bit.** This option is listed for completeness. It needs two slots per value and is the
   largest change.

No implementation until the representation is decided (lead decision, 2026-11-19).
