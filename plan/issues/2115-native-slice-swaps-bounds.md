---
id: 2115
renumbered_from: 1956
title: "nativeStrings slice() swaps start/end like substring — \"hello\".slice(3,1) returns \"el\" instead of \"\""
status: wont-fix
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: string-methods
goal: standalone-mode
related: [1381, 2116]
origin: "2026-06-10 deep-audit sweep (strings agent): verified miscompile on main, native backend"
---

# #2115 — native `__str_slice` delegates to the swapping substring helper

## Problem

Per [§22.1.3.21](https://tc39.es/ecma262/#sec-string.prototype.slice), `slice`
must NOT swap when start > end (returns `""`). The native helper swaps.

## Repro (verified on main, `{ nativeStrings: true }`)

```ts
export function test(): number { return "hello".slice(3, 1).length; }
```

wasm native: `2` (`"el"`) — node and jsHost backend: `0` (`""`).
Also corrupts `slice(1, undefined)` (undefined→0 → swap → `"h"`).

## Root cause

`src/codegen/native-strings.ts:2022-2026` — `__str_slice` resolves negatives,
then delegates to `__str_substring` "which handles clamping to len **and
swapping**". The swap is correct for substring only. #1381 fixed the host path;
the native helper was never fixed.

## Fix direction

In `__str_slice`, after clamping, emit `if (start >= end) return empty`
instead of delegating to the swapping substring helper.

## Acceptance criteria

- `"hello".slice(3,1) === ""` in native mode
- Negative-index slices unregressed
- jsHost path untouched

## Dupe check

#1381 (done) lists "substring-vs-slice swap" and fixed the **host** path only.
No open issue mentions the native-side swap.

## Closed as duplicate (2026-06-12)

Duplicate of #2123 — the same audit batch was filed twice (#2110–#2117 ≡ #2118–#2125). The high series is canonical: merged/open PRs reference #2120–#2125. No work was lost; see #2123.
