---
id: 4225
title: "bug: compile-time `in`/`hasOwnProperty` fold answers constant FALSE for a cold-moved fnctor field on a struct-typed receiver (cold tail is default-ON)"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: objects
goal: core-semantics
related: [3927, 3920, 3537]
origin: "found by the #3927 per-type-layout emission slice while auditing its own flag-ON interaction with PR #4229's fold fix; reproduced flag-free on current-main behavior"
---

# #4225 — the static own-property fold is blind to the cold tail (folded-0 side)

## Problem

`binary-ops-in.ts:317` / `object-ops.ts:4557` fold `"key" in recv` /
`recv.hasOwnProperty("key")` at compile time when the receiver is
struct-typed, from `structFieldNames.includes(key)`. The #3927 hot/cold split
(DEFAULT-ON in standalone at K=20) **removes** cold-moved fields from the
base struct's field list — their values live in the `$__fnctor_<Name>__cold`
tail, their presence bits in the tail's words. So for a cold-moved name the
fold answers `includes() === false` and, because the receiver is a struct ref
(not externref), skips the `__extern_has` runtime arm and emits a **constant
FALSE** — for a property the instance really carries.

This is the **folded-0 twin** of #3920's second half: PR #4229 replaces the
folded **1** with a presence-word read (a folded 1 was wrong for
conditionally-assigned fields never written); the folded **0** keeps its
constant there, and the cold split is what makes folded-0 unsound.

## Repro (flag-free, current defaults; `.tmp/probe-cold-fold.mjs` idiom in the #3927 worktree)

25 flow-grown conditionally-assigned fields on one fnctor (cold split moves
`f21..f25` to the tail at K=20), then:

```js
var n = new Node();          // struct-typed receiver
var a = launder(n);          // any-typed alias (launder returns x ? x : null)
a.f22 = 7;                   // dynamic write → cold-tail arm, presence bit set
"f22" in n;                  // → compile-time constant
n.hasOwnProperty("f22");     // → compile-time constant
a.f22 === 7;                 // → true (value round-trips through the tail)
```

Measured (standalone, optimize 0): **native 111, wasm 001** — the value
round-trips, both reflective answers are a constant false. The same probe on
a HOT field is answered by the folded-1 side, which PR #4229 owns.

**Re-measured 2026-08-08 after PR #4229 merged: native 111, wasm 101.** The
`in` operator now answers correctly on this repro; the residual is the
`hasOwnProperty` site (`object-ops.ts` `compilePropertyIntrospection`),
whose #3920 fix deliberately replaces ONLY a folded **1**
(`emitHasOwnPresence` — "Replace ONLY a folded 1") and leaves the folded 0
constant. Scope of the fix shrinks accordingly: teach the folded-0 exit at
that site (and audit `propertyIsEnumerable` / `Object.hasOwn` if they share
it) the off-base-carrier check via `findColdStructsForField` +
`coldFieldPresenceInstrs`.

## Fix shape

At both fold sites, before treating `includes(key) === false` as a constant
0 on a struct-typed receiver whose struct is a split fnctor: consult the
family's off-base carriers — `findColdStructsForField(ctx, key)` filtered to
this struct (and, once #3927's per-type emission is default-ON,
`fnctorLayoutOwnFieldsFor`/`findFnctorResidStructsForField`) — and demote the
fold to the runtime presence read. PR #4229's presence-word mechanism is the
substrate: the cold case reads the bit through the `$cold` hop
(`coldFieldPresenceInstrs`), the per-type-layout case reads the BASE words at
fixed indices (already layout-independent by construction).

Scope note: the un-split gap for names that were never reserved anywhere at
all is #3537 (expando storage), not this issue — here the name HAS storage
and a presence bit; only the fold cannot see them.

## Acceptance criteria

- [ ] The repro answers 111 in standalone with default flags.
- [ ] A never-written cold field still answers false (`in`/`hasOwnProperty`)
      — i.e. the fix reads presence, it does not blanket-fold to 1.
- [ ] No change for non-fnctor closed structs (fold behavior preserved where
      the field list is complete).
- [ ] Cross-check with #3927 §6 item 2b, which tracks the per-type-layout
      flavor of the same hole for its default-ON gate.
