---
id: 4071
title: "Own-property ENUMERATION is dead in standalone for array indices and function own properties — Object.keys returns [] while writes round-trip"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: object-enumeration
goal: standalone-mode
related: [4055, 4061, 4062]
---

# Own-property enumeration is dead in standalone for array indices and function own properties

> Filed 2026-08-02 from a measured finding reported by the `H-descriptor` agent
> while it was working the descriptor-shape family. It is **not** part of that
> family and was explicitly handed over rather than folded in.

## Defect

In **standalone** mode, own-property **enumeration** is dead for two carrier
kinds, while the underlying writes round-trip correctly:

```js
Object.keys([10, 20, 30]).length; // 0   — expected 3
Object.keys(fnWithOwnProp).length; // 0   — expected 1
```

Array **index keys are not enumerated at all**. Reads and writes work in both
cases — only enumeration is missing. So this is a **silent wrong answer**, not a
refusal: nothing downstream can detect it, and no host-import leak names it.

## Why it is filed separately, and why it may be the bigger lever

The reporting agent surfaced this while decomposing a **50-file** goal-scope
bucket (the `Object.defineProperties`/`create` receiver-representation ceiling,
tracked separately). Its assessment, which this issue adopts:

> "That is almost certainly a bigger lever than my 50."

`Object.keys` is not a leaf builtin — it shares the own-property enumeration
substrate with **`for-in`, `Object.getOwnPropertyNames`, object spread, and
`JSON.stringify`**. If enumeration is dead for vec carriers and closure
carriers, every one of those surfaces is wrong on the same inputs.

## ⚠ Blast radius — read before starting

The reporting agent **deliberately did not touch** `__object_keys` /
`__hasOwnProperty`, and gave the reason: the blast radius is for-in /
`Object.keys` / spread / `JSON.stringify`, and **the at-risk set is not
enumerable cheaply**. Treat that as a live warning, not a formality:

- Do **not** size this from the two repro lines. Enumerate the affected
  population against the standalone baseline JSONL first, and state the
  denominator.
- A fix here can regress passing tests in four surfaces at once. Establish the
  before-state per surface, then re-measure per surface.

## Relationship to the descriptor family

Adjacent but **distinct** from the receiver-representation refusals in
`Object.defineProperties`/`Object.create` (the two-disjoint-side-tables
substrate — `src/codegen/vec-props.ts` #3537 expando bag,
`src/codegen/vec-overlay.ts` #3251 descriptor overlay, each scoping the other
out in its own header comment). Those are **refusals**; this is **silent wrong
enumeration**. They plausibly share the substrate — confirm that before
assuming either subsumes the other.

## Acceptance criteria

1. `Object.keys([10,20,30])` returns `["0","1","2"]` in standalone.
2. `Object.keys(fn)` includes the function's own properties.
3. The same population is checked through `for-in`, `getOwnPropertyNames`,
   spread and `JSON.stringify` — with per-surface before/after counts.
4. Net flips reported against a force-refreshed standalone baseline, with the
   denominator stated. **Report flips, not file counts.**
