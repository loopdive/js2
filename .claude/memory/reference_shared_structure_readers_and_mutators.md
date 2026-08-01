---
name: reference_shared_structure_readers_and_mutators
description: "Before WRITING to a shared structure enumerate its readers; before MOVING data OUT of one enumerate its mutators — the first tells you what you'll perturb, the second what you'll lose"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-31T05:46:00.223Z
---

# Two-sided rule for shared compiler-context structures

Both halves were learned the hard way on **one map** (`ctx.definedPropertyFlags`),
in sequence, on the same PR — each mistake caused a merge_group park.

## Half 1 — before WRITING to a shared structure, enumerate its READERS

A record was added to `definedPropertyFlags` intending to feed one new consult. The
map had **four** readers, and one of them —
`builtin-static-gopd.ts:620` — lets a present entry **override the shape table**, so
`getOwnPropertyDescriptor` began reporting `enumerable:false, configurable:false`
for redefines of existing properties. The safety argument at the time checked
*one* reader (redefine-validation) and concluded the write was safe.

> Checking one consumer of a shared map and concluding the map is safe is not an
> enumeration.

## Half 2 — before MOVING data OUT of one, enumerate its MUTATORS

The fix moved the record to a dedicated `nonWritableExternKeys` set — correct for
blast radius, and it **silently dropped the invariants membership had conferred**.
`definedPropertyFlags` (with `frozenVars` / `sealedVars` / `nonExtensibleVars`) is
**snapshot+restored between top-level pass 1 and pass 2** because it encodes
**program order**. The new set was in neither snapshot, so a top-level write
*preceding* its `defineProperty` compiled as a write to a non-writable property —
a wrong answer with no compile failure.

`declarations.ts:2337` documents the failure mode explicitly ("defines that PRECEDE
an `Object.freeze(o)` compile as if the object were already frozen") — the comment
was read during the work and still not connected.

## The check, and it is cheap

**`grep` the MUTATIONS, not just the reads.** For `definedPropertyFlags` that is
five sites, and the replacement needs a counterpart at every one:

| site | purpose |
|---|---|
| `create-context.ts:364` | initializer |
| `declarations.ts:2353` / `:2365` | program-order snapshot / restore |
| `index.ts:6020` / `:6029` | multi-module snapshot / restore |

Five sites, five counterparts ⇒ full parity, no invariant gap.

## Half 3 — an APPROXIMATE structure becomes WRONG when you make it load-bearing

The root cause of the 27 regressions was neither half above. `definedPropertyFlags`
is **approximate about writability**: `applyDescriptorFlags` leaves the WRITABLE bit
clear when a descriptor merely **omits** `writable`. That is correct for a fresh
define and wrong for a **redefine**, where omitted means "keep existing".

Its historical consumers — gOPD reporting, redefine validation — *tolerated* that
approximation. A new consult made the same map decide whether a **write is legal**,
and the approximation became a correctness dependency. Demonstration:
`mapped-arguments-nonconfigurable-4.js` sets only `configurable:false`, never
mentions `writable`, and the write was suppressed.

> **Converting a tolerated approximation into a correctness dependency is a change
> to the structure's contract, even when you write no code that touches it.**

Before consulting an existing structure for a **new kind of decision**, ask what its
existing consumers *tolerate*. A field that is "close enough" for reporting can be
flatly wrong for gating. Fix: require the **explicit** signal (here, an explicit
`writable: false`, recorded from all three lowering arms — the third only surfaced
when narrowing too far regressed `8.7.2-3-s.js`).

## Why this generalises

Reducing blast radius by extracting state from a shared structure is usually right —
but a shared structure is not only a *container*, it is a set of **behaviours** its
members inherit (lifecycle, ordering, snapshotting, invalidation). Extraction keeps
the data and loses the behaviours, silently, with no type error.

Related: [[reference_budget_grant_from_another_issue_fails_in_ci]] and the wider
"reports itself as authoritative and isn't" family — this one has no misleading
signal at all, which is why only enumeration catches it.
