---
id: 2131
title: "JS-host Object.keys/for-in enumeration ignores the integer-keys-ascending-first ordering rule"
status: done
sprint: 61
created: 2026-06-12
updated: 2026-06-12
completed: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [1837]
renumbered_from: "residual of #1837 (done, standalone path only) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2131 — JS-host enumeration emits insertion order, never reorders integer keys

## Problem

Property enumeration in JS-host mode follows insertion order and does not move
integer-index keys to the front in ascending numeric order, as
`OrdinaryOwnPropertyKeys` (ES §10.1.11.1) requires.

```ts
const o: any = { b: 1, "2": 2, a: 3, "1": 4 };
Object.keys(o).join(",")
// wasm: "b,2,a,1"     node: "1,2,b,a"
```

Required order: array-index keys (canonical numeric strings) first, in
ascending numeric order; then string keys in insertion order; then symbol keys
in insertion order.

## Scope

#1837 fixed the **standalone** path (hash-bucket order → spec order). The
**JS-host** enumeration path was not covered and still emits raw insertion
order. This issue is the JS-host counterpart.

## Root cause (pointer)

The JS-host `Object.keys` / `for-in` key source preserves the struct field
declaration order without partitioning integer-index keys. The fix mirrors
#1837's standalone ordering: split keys into (ascending integer indices) ++
(insertion-ordered string keys) ++ (symbol keys). See the enumeration / keys
emission for JS-host mode (grep `Object.keys` / `for-in` key collection in
`src/codegen/` and the host import wiring).

## Acceptance criteria

- `Object.keys({ b:1, "2":2, a:3, "1":4 })` → `["1","2","b","a"]`
- `for (const k in o)` visits keys in the same order
- Pure-string-key objects keep insertion order (no regression)
- An equivalence test under `tests/` (assert both JS-host and, where it
  already passes, standalone)

## Notes

Verified on main `c19a2e9c1` via `.tmp/triage.mts` (branch `po-1971-triage`),
default options (JS-host). Cross-check against #1837's standalone fix so both
paths share one ordering helper if practical.

## Resolution (2026-06-12)

Added a shared host-runtime helper (`src/runtime.ts`):
`_isCanonicalArrayIndexKey` (canonical numeric string in [0, 2^32-2]) +
`_orderOwnKeysSpec` (array-index keys first ascending, remaining keys keep
insertion order; returns the input unchanged when no index key exists — the
common pure-string fast path). Applied at every JS-host struct key-emission
site:

- `__object_keys` / `__object_values` / `__object_entries` struct branches
  (values/entries map over the ordered key list so all three agree)
- `__for_in_keys` struct chain walk — each prototype level's own keys
  (fields + enumerable sidecar) are collected, ordered, then pushed, per
  EnumerateObjectProperties
- `_ownStructKeys` (feeds getOwnPropertyNames / getOwnPropertyDescriptors)

Plain JS objects already get spec order from V8 natively; the standalone
path was fixed by #1837 and is unchanged.

## Test Results

- `tests/issue-2131.test.ts` — 7/7: Object.keys (`1,2,b,a`), for-in same
  order, Object.values (`4,2,1,3`), Object.entries key order, pure-string
  insertion order kept, non-canonical `"01"` NOT reordered, standalone
  parity.
- Enumeration suites: `issue-1837` + `issue-786-object-keys-dynamic` +
  `object-keys-values-entries` 23/23; `issue-forin` 5/5.

## Out of scope (pre-existing on main, verified)

`for (const [k, v] of Object.entries(o))` destructuring over a struct-backed
entries result throws "undefined is not iterable" on main — unrelated to
ordering (the entries test here asserts via index access).
