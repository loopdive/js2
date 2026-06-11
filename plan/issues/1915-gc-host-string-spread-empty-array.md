---
id: 1915
title: "gc JS-host mode: [...str] / Array.from(str) returns empty array (externref-spread gap)"
status: backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
goal: core-semantics
sprint: Backlog
related: [1470]
---

# gc JS-host mode: spreading a string yields an empty array

## Problem

In the **default (JS-host / WasmGC) lane**, array-spreading a string produces an
**empty array** instead of the array of its characters:

```js
[..."abc"]        // → []        (expected ["a","b","c"])
Array.from("abc") // affected by the same externref-spread gap
```

This is a **pre-existing gap on the externref string-spread path** — it is
**not** a regression from #1470. It was discovered and verified on current main
(HEAD ~`6efc0d279`) by `fable-1470` while doing the #1470 standalone residual
sweep, and confirmed to reproduce independently of that change.

## Scope boundary (why this is its own issue)

#1470 (`fable-1470`, PR #1302) fixed the **standalone** string-iteration
residual — `[...str]`, `Array.from(str)`, `for-of`, and surrogate-pair
correctness (§22.1.5.1 code points) — with pure-Wasm helpers
(`__str_to_char_vec`, `__str_charAt_cp`). That work is confined to the
standalone path. The **gc JS-host** path spreads a string through the externref
iterator/`__array_from` route, which has its own distinct empty-array bug. It is
explicitly out of #1470's standalone scope, hence this separate issue.

## Repro

```ts
// default target (gc / JS-host), no --target standalone
const r = [..."abc"];
// observed: r.length === 0
// expected: r.length === 3, r[0] === "a"
```

## Suspected area

The externref spread / `GetIterator(string)` path in the gc backend — string
values reaching the array-spread builder via externref don't yield the
per-character iterator the standalone path now handles. Cross-check against the
standalone fix in #1470 (PR #1302) for the correct code-point iteration
semantics to mirror on the host path.

## Acceptance

- `[..."abc"]` → `["a","b","c"]` and `Array.from("abc")` → `["a","b","c"]` in the
  default gc/JS-host lane.
- Surrogate pairs iterate by code point (§22.1.5.1), matching the standalone
  behavior delivered in #1470.
- A `tests/` case covering host-lane string spread (the existing #1470 tests
  cover the standalone path only).
