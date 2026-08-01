---
id: 4007
title: "Array length is absent from descriptor reflection entirely in standalone (gOPD undefined, gOPN omits it) while hasOwnProperty says true"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-gap
related: []
---

# Array length is absent from descriptor reflection entirely in standalone (gOPD undefined, gOPN omits it) while hasOwnProperty says true

## Problem

On the standalone lane an array's `length` is invisible to descriptor reflection:

- `Object.getOwnPropertyDescriptor(arr, "length")` → `undefined`
- `Object.getOwnPropertyNames(arr)` omits it
- but `arr.hasOwnProperty("length")` → `true`

The property exists but is not reflected.

## Discriminators already run — do NOT redo these

- `gOPD` works correctly on array **indices** ⇒ not "gOPD broken on arrays"
- `gOPD` works correctly on **plain-object** properties ⇒ not "gOPD broken generally"
- `gOPD` works on the key `"length"` when the **receiver is a plain object**
  ⇒ not "the key `length` is special"

The defect is specifically the **(array receiver × `"length"` key)** cell.

## Why it matters beyond its own files

It makes the standalone lane **useless as an instrument** for any descriptor
question about array `length` — it is exactly what confounded the first probe of
the sibling `writable`-dropped-on-store defect. Fixing this restores the ability
to measure that one directly on standalone.

Found by `g-arraylen` 2026-08-01. Standalone-only. Together with the `writable`
defect it gates most of the files the array-`length` routing fix did not flip.
