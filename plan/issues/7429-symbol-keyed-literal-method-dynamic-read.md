---
id: 7429
title: "`(o as any)[Symbol.iterator]` on an object literal's `[Symbol.iterator]() {}` method answers undefined"
status: blocked
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: ir-full-coverage
depends_on: [7432]
related: [7410, 7427, 7432]
---

# #7429 — A symbol-keyed object-literal method read through `any` answers undefined

## Problem

Found while testing #7410. On default and standalone (main `89e4748241`):

```ts
const o = { [Symbol.iterator]() { return 7; } };
const f: any = (o as any)[Symbol.iterator]; // undefined
f.name;                                      // throws: reading `name` of undefined
```

| key | `(o as any)[Symbol.<key>]` |
| --- | --- |
| `iterator` | `undefined` |
| `toStringTag` | `undefined` |
| `split` | `undefined` |
| `match` | `undefined` |
| `toPrimitive` | the method (it has its own dispatch) |

## Cause

The object literal stores the method in a struct field spelled `@@iterator` (`resolveWellKnownSymbol`). The
read through `any` uses the real boxed symbol as its key, and the two never meet. This is one of the
mismatches #7432 records. It is not the escaped `__@x@<id>` name of #7410/#7427, so #7427's member-key helper
does not reach it.

## Fix

Step 3 of #7432's migration: a dynamic read with a well-known key on a known struct resolves to the canonical
field, or the struct materializes with real symbol keys.

## Acceptance

- The table above answers the method on default and standalone, and `.name` is `"[Symbol.iterator]"` (and so
  on), matching node.
