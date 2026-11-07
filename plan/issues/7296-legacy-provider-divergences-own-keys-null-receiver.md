---
id: 7296
title: "Legacy standalone providers diverge from node: getOwnPropertyNames(null) and hasOwnProperty on null do not throw; Uint8Array lists `length`"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
goal: core-semantics
related: [7283, 7269, 7106]
---

# Legacy providers diverge from node on own-key and own-property queries

## Problem

The fresh review of #7283 (PR #7151) found three cases where the object
runtime's providers answer differently from node. It found them while
probing the propertyHelper aliases, but the providers are legacy's own, and
legacy answers the same way.

| call | node | gc and standalone (legacy and IR alike) |
| --- | --- | --- |
| `__getOwnPropertyNames(null)` (alias of `Object.getOwnPropertyNames`) | TypeError | returns an empty list |
| `__getOwnPropertyNames(undefined)` | TypeError | returns an empty list |
| `__getOwnPropertyNames(new Uint8Array(2))` | `0,1` | `0,1,length` |
| `Object.getOwnPropertyNames(new Uint8Array(2))` (direct, not via alias) | `0,1` | `0,1,length` |
| `__hasOwnProperty(null, "a")` (uncurried `Object.prototype.hasOwnProperty`) | TypeError | `false` |
| `__hasOwnProperty(undefined, "a")` | TypeError | `false` |

Repro: `.tmp/fx/p296.js` in the #7283 worktree (summarised above), run with
`runTest262File` on standalone and gc.

## Cause (where to look)

- `__getOwnPropertyNames` / `__hasOwnProperty` are the native object-runtime
  providers (`src/stdlib/object-runtime.ts` signatures; bodies in the
  `src/codegen/object-runtime-*.ts` family).
- Neither provider applies ToObject to its receiver, which is what makes
  `null` / `undefined` throw (§20.1.2.10 step 1, §20.1.3.2 step 2).
- The own-key list of a typed array includes `length`, which is an
  accessor on `%TypedArray%.prototype` and not an own property.

## Relation to the IR lanes

#7269 / #7283 lower the certified aliases to these same providers, exactly
as legacy does. So IR-claimed functions inherit the divergences by design,
and fixing the providers fixes both frontends at once.

## Acceptance

Every row above matches node on gc, standalone and wasi, with a test.
