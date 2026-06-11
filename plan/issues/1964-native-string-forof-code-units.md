---
id: 1964
title: "nativeStrings: for-of over a string iterates code units, not code points (4 iterations for \"a😀b\")"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: iterators
goal: standalone-mode
related: [1183, 1962]
origin: "2026-06-10 deep-audit sweep (strings agent): empirical confirmation of the follow-up #1183 asked for"
---

# #1964 — string iteration ignores surrogate pairs in native mode

## Problem

The String iterator ([§22.1.5](https://tc39.es/ecma262/#sec-string-iterator-objects))
yields **code points**. Native-strings for-of yields code units:
`for (const c of "a😀b")` runs 4 iterations (node: 3), and the emoji arrives
as two lone surrogates (first chunk length 1 instead of 2).

## Status of knowledge

#1183 marked this out of scope with "surface a follow-up if test262 exposes
the discrepancy" — this empirical confirmation is that trigger; no follow-up
existed until now.

## Fix direction

In the native string for-of lowering, check `charCodeAt(i)` for a high
surrogate with a following low surrogate and yield the 2-unit substring,
advancing by 2. Share the surrogate-pair walk with the string-spread fix
(#1962) and `Array.from(string)` if applicable.

## Acceptance criteria

- `for (const c of "a😀b")` → 3 iterations, middle chunk length 2
- Lone surrogates still yielded as single units (spec)
- BMP-only strings keep the fast path

## Dupe check

#1183 explicitly deferred with a follow-up request; no follow-up issue
existed. jsHost path is correct (host iterator).
