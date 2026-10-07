---
id: 6857
title: "standalone Map subclass residuals: for-of destructuring CE, forEach/spread on the subclass, any-typed override dispatch"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: compiler
goal: standalone-mode
---

## Problem

These were measured while fixing
[#6754](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6754-standalone-map-subclass-struct-layout).
All of them reproduce on `upstream/main` b6324ee6d1 with a field-less
`class U extends Map { get(r) { … super.get(r) … } }` (JS, `--target
standalone`). None of them depend on #6754's carrier.

| shape | standalone | node |
| ----- | ---------- | ---- |
| `for (const [k, v] of u) …` | CE: `call[1] expected type (ref null 6), found block of type (ref null 63)` (invalid Wasm) | iterates |
| `u.forEach(() => n++)` | `n === 0` | 2 |
| `[...s.keys()].join()` on `class Seeded extends Map` | throws | `"a,b"` |
| `function viaAny(x, k) { return x.get(k) }; viaAny(u, "y")` | override not called (`0`) | override result |

Probe: `.tmp/b1.mjs`-style per-function exports, compiled with
`compileProject(..., { target: "standalone", allowJs: true })` and instantiated
with `{}`.

## Acceptance

Each row matches Node on the standalone lane, with a regression test per row.
