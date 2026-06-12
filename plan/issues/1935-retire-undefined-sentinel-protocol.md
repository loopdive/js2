---
id: 1935
title: "Retire the undefined-as-sentinel protocol in runtime.ts — getters returning undefined are misread as absent"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: compiler-internals
goal: correctness
---
# #1935 — Retire the undefined-sentinel protocol

## Problem

The host runtime pervasively uses `undefined` as an in-band "absent" signal,
which misinterprets user code that legitimately returns `undefined`:

- `safeGetField` treats a getter returning `undefined` as "getter absent"
  and falls through to sidecar/struct fields (`runtime.ts:3869-3873`:
  `const v = invokeGetter(getter); if (v !== undefined) return v;`). A user
  getter returning `undefined` silently yields the underlying field value
  instead.
- Same pattern in ToPrimitive paths (`prim !== undefined`, e.g.
  `runtime.ts:4658`, `:5046`) — a `valueOf` returning `undefined` is treated
  as "no valueOf".
- The file already demonstrates the correct pattern: `_PRIM_ABSENT` unique
  symbol (`runtime.ts:2079`) — it just isn't applied uniformly.

Property-lookup precedence is additionally re-derived in four places
(`_safeGet` :3307, `_wrapForHost` :3843-4133, `_readOwnDescriptor` :3685,
`_liveGet` :2790) that must all agree — fixing the sentinel must fix all
four consistently.

## Proposed approach

1. One exported `const MISS: unique symbol`; `invokeGetter`, sidecar
   lookups, and ToPrimitive step functions return `MISS` for absence.
2. Sweep the `!== undefined` fallthrough sites (grep
   `invokeGetter|_PRIM_ABSENT|!== undefined` in runtime.ts) and convert.
3. Differential tests (equivalence suite): getter returning `undefined`
   shadows a field; `valueOf` returning `undefined` falls through to
   `toString` per spec ToPrimitive (it should — but via the spec path, not
   the absent path); `Object.assign`/spread over such objects.

## Acceptance criteria

- The getter-returns-undefined test matches V8 in the equivalence harness.
- One absence sentinel; `_PRIM_ABSENT` either renamed/unified or removed.
- test262 js-host lane net non-negative.

## Source

Compiler quality review 2026-06. Related: #1934 (the four lookup paths).
