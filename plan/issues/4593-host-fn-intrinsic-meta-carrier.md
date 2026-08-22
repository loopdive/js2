---
id: 4593
title: "JS-HOST: mint the `$__fn_instance_meta` carrier in host mode so `gOPD(fn,'length'/'name')` stops returning undefined — the host half of #4562, a representation change"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: 5
language_feature: functions
goal: test262-conformance
related: [4562, 4437, 2896]
origin: "2026-08-21 wave-2 function lane, while fixing #4562's standalone half. Split out because the host half is a representation change, not a validation-input fix."
---

# #4593 — host mode has no function-intrinsic meta carrier

## Why this is a separate issue from #4562

#4562's standalone fix seeds the intrinsic `length`/`name` as a real property
record on first define, then lets the proven §10.1.6.3 merge run. That fix is a
**validation-input** change and lands entirely in the standalone carrier-bag
substrate.

The host lane cannot take the same fix, and the reason is decisive:

> `src/codegen/function-instance-meta.ts:200` — `if (!ctx.standalone) return
> undefined`. **The `$__fn_instance_meta` carrier is never minted in js-host
> mode.**

So on host there is no function-visible `name` at all, and no §15.1.5-exact
`length` to feed `_readOwnDescriptor` (`src/runtime.ts:5522`) — the single
place that would fix both host symptoms at once. Host's only visible arity
today is the `__closure_arity` bridge export, which is the **declared formal
count** — the exact value #4437 rejected as the spec `length`
(`function f(x = 42) {}` has arity 1 but spec length 0).

## Symptoms on host, today

- `Object.getOwnPropertyDescriptor(fn, "length")` → `undefined` (should be
  `{value, writable:false, enumerable:false, configurable:true}`).
- `Object.getOwnPropertyDescriptor(fn, "name")` → `undefined`.
- A partial `defineProperty` over either then behaves as a fresh define
  (everything omitted is lost) — same downstream symptom as #4562's standalone
  half, different root.

## What the fix needs (all three, together)

1. **Mint the meta carrier in host mode** — lift the `!ctx.standalone` early
   return in `function-instance-meta.ts` and pay whatever module-shape cost
   that carries on the host lane.
2. **A new closure-host-bridge export** carrying the spec `length` (not the
   formal count) and the `name`, so the host runtime can see them.
3. **A `_readOwnDescriptor` arm** (`src/runtime.ts:5522`) consuming that
   export, so gOPD/defineProperty see the intrinsic as a real own property.

## Verification requirements

- Both-lane conformance runs (`built-ins/Object/defineProperty` 1131-row dir +
  the Function tree), base vs new.
- The #4562 standalone probe table must stay spec-correct — the two fixes meet
  at the same test rows.
- The #4437 distinction (arity vs spec length) needs its own test on the host
  lane: `function f(x = 42) {}` must read `length === 0`.

## Non-goal

Do not attempt this as a slice of #4562. The wave-2 lane measured the boundary
precisely and the standalone fix is deliberately inert on host
(`fnIntrinsicSeedInstrs` returns `[]` when `!ctx.standalone`).
