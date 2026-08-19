---
id: 4225
title: "bug: compile-time `in`/`hasOwnProperty` fold answers constant FALSE for a cold-moved fnctor field on a struct-typed receiver (cold tail is default-ON)"
status: done
completed: 2026-08-08
assignee: ttraenkler/opus-forin-2
sprint: 78
created: 2026-08-08
updated: 2026-08-18
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

- [x] The repro answers 111 in standalone with default flags.
- [x] A never-written cold field still answers false (`in`/`hasOwnProperty`)
      — i.e. the fix reads presence, it does not blanket-fold to 1.
- [x] No change for non-fnctor closed structs (fold behavior preserved where
      the field list is complete).
- [x] Cross-check with #3927 §6 item 2b, which tracks the per-type-layout
      flavor of the same hole for its default-ON gate.

---

## Resolution (2026-08-08, `ttraenkler/opus-forin-2`)

Landed as a follow-up stacked on PR #4229 (#3920's static-fold half), which is
where both fold sites already route through one presence derivation.

### Correction to the filed repro: `in` was ALREADY fixed, `hasOwnProperty` was not

Measured on the #4229 branch before this change, digits `1`=`in`,
`10`=`hasOwnProperty`, `100`=value read-back:

| arm | cold field, written |
| --- | ---: |
| pre-#4229 | **100** — both reflective answers constant-false (the filed reading) |
| #4229 | **101** — `in` fixed, `hasOwnProperty` still constant-false |
| this change | **111** |

The asymmetry is the whole diagnosis. `binary-ops-in.ts` passes the receiver's
struct type to the shared helper unconditionally, so its cold lookup already
ran. `object-ops.ts` gated the call on `result === 1` — a deliberate #4229
conservatism — and a cold field folds `result === 0`, so the helper was never
reached. **One call site had the fix and the other could not get to it.**

### Fix

`findPresenceStorage(ctx, structName, key)` in
`src/codegen/closed-struct-presence.ts` is now the single union-aware source of
truth: base `$presence_<w>` bit, `$cold` hop, or nothing. Both fold sites
consult it; #3927's per-type emission extends **it**, not the call sites.

The two fold directions are deliberately **not** symmetric:

- **folded `1`** → demote on any storage (a conditionally-assigned field may
  never have been written) — #3920's side.
- **folded `0`** → demote **only** for OFF-BASE storage. A base-resident name
  that folded to `0` did so for a reason the presence bit does not know about;
  `propertyIsEnumerable` answering `0` for a non-enumerable field is the live
  example, and reading the bit there would turn a correct `false` into a wrong
  `true`. `findPresenceStorage` is itself the discriminator — a non-enumerable
  base field has no cold location, so it never fires.

### Test evidence

`tests/issue-4225.test.ts`, 5 tests. Kill-switch A/B reverting only
`object-ops.ts` + `closed-struct-presence.ts` to the #4229 branch:

| | this change | #4229 baseline |
| --- | --- | --- |
| fixture really splits (instrument check) | pass | **pass** |
| written cold field present | pass | fail `101` vs `111` |
| never-written cold field absent | pass | **pass** |
| hot field, both directions | pass | **pass** |
| name with no storage stays folded false | pass | **pass** |

Exactly one row moves. The **instrument check is the load-bearing one**: cold
eligibility needs flow-grown AND `externref` fields, and the first draft of this
fixture used numeric values, so nothing split and the "repro" passed on every
arm while measuring an un-split struct. That test reads the emitted types and
fails if the tail is missing or does not hold the probed name.

Ranking note for anyone extending the fixture: the cold tail holds `f5`..`f9`,
not `f21`..`f25` — hot fields are the top-K by static write-site count with ties
broken by name **ascending**, and `"f10"` sorts before `"f5"`.
