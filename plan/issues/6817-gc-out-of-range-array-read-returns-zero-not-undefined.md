---
id: 6817
title: "codegen (gc): reading past the end of a `number[]` gives 0 — `a[5] === undefined` is false and `typeof a[5]` is number"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: arrays
goal: core-semantics
related: [6806, 6788, 2358]
requested_by: ttraenkler/claude-review
origin: "found by the 2026-09-30 review probes and confirmed on 9d977a7e by the #6798 implementation's probe set (2026-10-02); unfiled until now"
---
# #6817 — an out-of-range element is `undefined`, not the element type's zero

## Problem

```ts
export function run(): string {
  const a = [1, 2, 3];
  return JSON.stringify([a[5] === undefined, typeof a[5], a[5] ?? "dflt", a.at(7)]);
}
```

| lane | result |
|---|---|
| wasm (JS host, `9d977a7e`) | `[false, "number", 0, 0]` |
| JS | `[true, "undefined", "dflt", null]` (JSON of `undefined` is `null`) |

The f64-vec element read clamps or zero-fills past `length` instead of
producing the undefined sentinel. The static path knows the element type is
`number` and so emits a bare `f64` read; nothing represents "no element".
(Holes in literals — `[1, , 3]` — are a separate, partly handled case: #6806.)

## Correction

An index read that can be out of range (any non-constant index, or a constant
index not provably `< length`) must produce the undefined sentinel the
carrier already uses for holes and compare equal to `undefined`. For a slot
typed `number` the result type widens to `number | undefined` at that site;
the cheapest shape is a bounds check feeding the existing sentinel-NaN
representation and a `===`/`typeof`/`??` lowering that recognises the
sentinel (the #6798 work added the same recognition for `boolean | number`
slots). `at()` with an out-of-range index returns the same sentinel.

## Acceptance

- The probe matches JS on both lanes; `a[0]` / `a[i]` with `i < length`
  keep the current bare-`f64` WAT shape (assert with the #6787 WAT-shape test
  pattern).
- New `tests/issue-6817-oob-read.test.ts`; row in `tests/guard-suite.json`.
