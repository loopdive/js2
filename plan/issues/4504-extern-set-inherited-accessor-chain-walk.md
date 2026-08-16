---
id: 4504
title: "Standalone: [[Set]] ignores inherited accessors — §9.1.9 proto-chain accessor walk in __extern_set"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
assignee: claude/es6-team-reflection
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [2175, 1888, 4206, 4491]
---

# #4504 — `[[Set]]` ignores inherited accessors

Split out of #2175's "P1" after a baseline probe disproved that issue's premise.
#2175 P1 framed this as a defect in the builtin-prototype COMPANION store; it is
not. The companion case is one special case of a general missing feature.

## Problem — §9.1.9 OrdinarySetWithOwnDescriptor step 3 is not implemented for
## inherited accessors

Assigning to a property whose nearest definition on the prototype chain is an
ACCESSOR must invoke that accessor's `[[Set]]` with the original receiver and
create **no** own property. Standalone instead creates an own data property,
silently shadowing the accessor.

### Evidence A — plain prototype chain, no builtin proto, no companion

`.tmp/q1.js` — `var proto = {}; Object.defineProperty(proto, "acc", {get, set});
var o = Object.create(proto); o.acc = 7;`

| assertion | spec | measured |
| --- | --- | --- |
| setter runs | yes | **no** |
| no own property created on `o` | none | **an own property IS created** |
| `o.acc` re-reads as 42 (the getter) | 42 | **not 42** |
| inherited DATA control: `o2.d = 5` creates an own prop, `proto2.d` unchanged | yes | yes OK |

Provenance: `--target standalone`, host-free. Measured on HEAD **and** on the
pre-P2 commit `3e69b1e34` — both return the same `700`, so the defect is
pre-existing and unrelated to #2175 P2 (which touched only `__hasOwnProperty` /
`__getOwnPropertyDescriptor`).

### Evidence B — builtin prototype via the companion store (the original "P1")

`.tmp/p4.js` — `Object.defineProperty(Array.prototype, "acc", {get, set});
var arr = [1,2,3]; arr.acc = 7;`

| step | spec | measured |
| --- | --- | --- |
| `arr.acc` read BEFORE the write | 42, getter runs | **42, getter runs** OK |
| `arr.acc = 7` | setter runs, no own prop | **setter never runs** |
| `arr.acc` read AFTER | 42 (still the getter) | **not 42** |
| `hasOwnProperty(arr, "acc")` | false | **true** |

The READ side is already correct on both shapes (`.tmp/p3.js`: the #4176 data
path and the accessor getter both work on an instance receiver). So this is
purely a `[[Set]]` gap, not a store or visibility gap.

## Root cause — a deliberate deferral, recorded in the source

`__extern_set`'s accessor write gate (`src/codegen/object-runtime.ts` ~L2846,
added by #1888 S5b) states it:

> "Inherited-accessor set (proto-chain) is out of scope for this slice;
> `__obj_find` walks only the own table."

So `[[Set]]` implements the OWN-accessor branch of §9.1.9 and skips the
prototype-chain branch entirely. `__obj_find` is own-table-only by construction.

## Why it must be fixed generally, not for companions only

Diverting only the companion case would make `Array.prototype`'s accessor fire
while a plain prototype's accessor still silently shadows — a half-consistent
`[[Set]]` whose behaviour depends on which store the accessor happens to live
in. That is the same failure mode the one-boundary rule exists to prevent, and
the reason #2175 P2 landed `hasOwnProperty` and `gOPD` together rather than
shipping the contained half alone.

## Scope

The ~11 companion candidates carried over from #2175 P1
(`.tmp/p1-cands.json`, regex-scoped) are a **LOWER BOUND**: they only count
tests whose source installs a setter on a *builtin prototype*. The general
defect affects every inherited accessor — user prototype chains, `Object.create`
chains and class hierarchies included — so the real target set must be
re-scanned, not inherited from that list.

## Implementation Plan (fable, dictated 2026-08-15)

1. **Template = the GET path's chain walk.** The read side already works on
   BOTH plain and companion protos, so locate that traversal and mirror its
   order exactly. Divergence between the get-walk and set-walk order is itself
   a bug.
2. **At the #1888 S5b gate site** (`object-runtime.ts` ~L2846), before the
   own-property create on a set-miss: find the first proto-chain entry for the
   key.
   - ACCESSOR **with** a setter → invoke it with the ORIGINAL receiver, create
     nothing.
   - **Getter-only** accessor → measure what the existing OWN getter-only set
     path does on base FIRST and mirror it exactly. Record the measured
     behaviour; do NOT invent strict/sloppy semantics.
   - DATA, or absent → today's own-property create, untouched.
3. **Companion protos are one ARM of the same walk**, via the #2175 P2
   receiver-substitution — not a separate code path.
4. **Gates.**
   - `prove-emit-identity` all 60, via conditional emission (the P2 pattern).
   - `.tmp/q1.js` and `.tmp/p4.js` both flip.
   - Negative controls on ONE binary: inherited DATA property still shadows;
     an OWN accessor still works; an absent key unchanged; getter-only mirrors
     the measured own-path behaviour.
   - Scoped run: the 11 companion candidates + `tests/issue-2175-*.test.ts` +
     `tests/issue-4447-forof-dstr-standalone.test.ts` + whichever test262
     bucket a fresh candidate scan says actually exercises inherited-accessor
     assignment. **Record the scan; pick measured, not guessed.**
   - Zero pass→non-pass on both lanes.
5. **One boundary**, keep/revert recommendation with plain numbers. 0 flips is
   acceptable if the gates hold, but real flips are expected here because the
   defect is general.

No git mutations. Stop and report on any surprise.

## Pre-implementation measurements (required by plan steps 1–2)

### Template — the GET path's chain walk (`__extern_get`, `object-runtime.ts` ~L2074)

```
block { loop {
  if (o == null) break
  e = __obj_find(o, key)
  if (e != null) {
    if (e.flags & FLAG_ACCESSOR) {
      getter = extern.convert_any(e.$get)
      if (getter == null) return undefined       // §6.2.5.5 step 3
      return __call_accessor_get(<ORIGINAL receiver>, getter)
    }
    ... data resolve ...
  }
  o = o.$proto ; br 0
} }
```

The load-bearing detail to mirror: the accessor is invoked with the **original
receiver** (param 0), never the proto-walk cursor. The set walk must use the
same start point (own layer first, then `$proto`) and the same order.

### Own getter-only `[[Set]]` — MEASURED on base, to be mirrored

`.tmp/q6.js`: `o = {}; defineProperty(o,"g",{get(){return 11}}); o.g = 5`

| observable | measured |
| --- | --- |
| throws | **yes** |
| `e instanceof TypeError` | **yes** (catchable, not a trap) |
| `o.g` afterwards | 11 — accessor intact, no own data property |

Confirmed via `WebAssembly.Exception` at the boundary + an in-module
`try/catch`. So the inherited getter-only arm mirrors: **throw a catchable
TypeError, create nothing, leave the accessor intact.**

**Recorded deviation, deliberately NOT changed here:** §9.1.9 makes a
setter-less assignment a silent no-op in SLOPPY mode and a TypeError only in
strict. We throw unconditionally. The #1888 S5b comment says the opposite was
intended ("a null setter is a sloppy no-op (strict TypeError deferred)"), so
base behaviour and its own comment disagree. Mirroring the measured behaviour is
what this plan requires; making sloppy/strict correct is a separate change and
must not be smuggled in here.

## Gate results (claude/es6-team-reflection, 2026-08-15)

Integrates as ONE commit with the #2175 P2 follow-up fix — same files. See
"FOLLOW-UP FIX — the first cut shipped INVALID WASM" in
`plan/issues/2175-standalone-builtin-prototype-readers.md` for that change-set's
evidence; it is a prerequisite here (it unblocked the p4 gate).

### What landed

The `$Object` `$proto`-chain accessor walk in `__extern_set`, spliced after the
own-entry block (which returns for every own case) and before the frozen gate +
own-create. Gated on `ctx.vecAccessorDescriptorDirty` — the #4159 pre-scan flag
for "a non-data descriptor may exist in this module". No non-data descriptor
anywhere ⇒ no accessor ⇒ no inherited accessor ⇒ the walk is dead code, so
accessor-free modules stay byte-identical.

**Step 3 (companion/vec receivers) is NOT in this change** — see below.

### Behavioural gates

| probe | before | after |
| --- | --- | --- |
| `.tmp/q1.js` plain-chain inherited accessor | 700 | **715** — setter fires, no own prop, getter still governs |
| `.tmp/q1.js` inherited-DATA control (same binary) | correct | correct — still creates an own prop, proto unchanged |
| `.tmp/q6.js` OWN getter-only assignment | 1111 | 1111 — unchanged |
| `.tmp/p4.js` companion/vec receiver | 203 | 203 — unchanged, step 3 not implemented |
| `prove-emit-identity` | — | **IDENTICAL, all 60** |

### Scans — how they were built, and why the inherited list was the wrong metric

- **The 11 carried-over #2175-P1 candidates: 0/11 flip.** Correct and expected —
  every one installs the accessor on a BUILTIN prototype, so the receiver
  reaches the companion store (step 3), not the `$Object` chain this walk
  covers. Counting them would have measured unimplemented work. Recording this
  rather than quoting "0 flips" flat: the list was inherited from a differently
  scoped issue and does not test what landed.
- **Fresh scan built for what DID land** (`.tmp/q-scan.ts`, recorded there in
  full): non-passing standalone entries whose source has an accessor definition
  AND a property assignment, reachable through an ORDINARY `$Object` chain, with
  builtin-prototype shapes explicitly excluded. Three shapes matched separately
  so the mix is visible: **24 candidates** — 16 `B-class-accessor` (a class body
  `set x(v)` lives on the prototype, so `new C().x = 1` is exactly this defect),
  7 `A-create/proto`, 1 `C-setproto`.
- **Result: 1/24 flips.** `built-ins/Object/defineProperty/15.2.3.6-4-591.js`.
  Verified as a GENUINE flip by A/B, not baseline staleness: on the pre-#4504
  tree it fails `assert(e instanceof TypeError)` at L50; with the walk it passes
  — the getter-only arm's mirrored TypeError is what satisfies it.

### Test sweep

9 files / 70 tests green: `issue-2175-p2-own-view-companion` (incl. the new
accessor-descriptor row), `issue-2175-{v2s3b,s3b3,native-proto-brands,
typeof-function-arm,v2s2}`, `issue-4447-forof-dstr-standalone`, `issue-2885`,
`issue-4160-proto-index-store`. Zero pass→non-pass anywhere.

### Measured, out of scope, NOT changed here

A setter-less assignment throws unconditionally where §9.1.9 makes it a silent
no-op in SLOPPY mode (TypeError only in strict). Base behaviour and #1888 S5b's
own comment ("a null setter is a sloppy no-op (strict TypeError deferred)")
disagree. The plan required mirroring the measured own-path behaviour, so the
inherited arm reproduces the throw rather than inventing sloppy/strict handling.
Worth its own id after review — note it currently makes 15.2.3.6-4-591 pass, so
"fixing" it would need that test re-checked.

### Next slice (named, not started)

**Step 3 — companion/vec receivers.** A vec/instance receiver never reaches
`__extern_set`'s `$Object` branch at all, so `arr.acc = 7` (p4) is a separate
site, not another arm of this loop. `__protoidx_own_recv` (from the P2 fix) is
the natural substitution primitive for it. Its gate is p4 flipping plus a re-run
of this battery.
