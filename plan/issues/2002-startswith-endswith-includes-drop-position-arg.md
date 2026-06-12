---
id: 2002
title: "startsWith/endsWith/includes silently drop the position/endPosition argument on the JS-host backend (import arity truncation)"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [1445, 2124]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2002 — STRING_METHODS declares 1-param imports; 2nd arg truncated

## Problem

```ts
"hello".startsWith("ll", 2)   // wasm: false   node: true
"hello".endsWith("ll", 4)     // wasm: false   node: true
"hello".includes("ll", 3)     // wasm: true    node: false
```

## Root cause

`src/codegen/index.ts:6296-6298` — `STRING_METHODS` declares
`includes`/`startsWith`/`endsWith` host-import params as `[externref]`
(search string only); the generic arg loop in
`src/codegen/expressions/calls.ts` truncates to import arity, so the 2nd
arg never reaches the host (the host shim forwards `...a` fine). The
native-strings backend (src/codegen/string-ops.ts:2030-2061) *does* pass
pos — only the default JS-host path drops it. `indexOf`/`lastIndexOf` have
2-param signatures and work.

## Fix direction

Widen the three import signatures to `[externref, f64]` with an
undefined/NaN sentinel for the omitted arg (parseInt pattern).

## Acceptance criteria

- All three repros match Node; no-position calls unchanged
- Native-strings backend unchanged

## Dupe check

#1445 (in-review) covers ToInteger coercion of these args, not the drop;
#2124 (ex-#1957) covers explicit-undefined args. New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1329; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
