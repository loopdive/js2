---
id: 4490
title: "standalone: builtin ctor own-property coherence — delete/gOPD disagree on synthetic meta arms; needs D7 ctor-value-as-real-$Object (one ctor per PR)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen
es_edition: es6
goal: standalone-mode
related: [4444, 2175, 4449]
---

# #4490 — builtin ctor own-property coherence (v2 D7 carrier change)

## Problem (measured, team-reflection triage 2026-08-15 — see #2175 S3b-3 notes)

~32 ES6-bucket standalone tests: the 18
`built-ins/TypedArrayConstructors/<View>/{length,name}.js` files plus the 14
`%TypedArray%` ctor-object statics from #2175's S3b-1 residual.

**The descriptors are already spec-correct** (`{value, writable:false,
enumerable:false, configurable:true}`). The failures come from
`verifyProperty` proving configurability by DELETE-then-recheck:
`delete C.length` answers true and `"length" in C` answers false, but
`gOPD(C, "length")` STILL returns a descriptor — because a builtin ctor's own
properties are served by **synthetic meta arms** (`__builtinfn_get_meta` +
`ta-ctor-meta.ts`, `builtin-static-gopd.ts`) that have no notion of deletion.
No table population can fix this while those arms answer independently of
mutation state.

## Direction

This is #2175 v2's **D7**: back the ctor VALUE with a real `$Object` (seeded
with the §17 own props) so reads, `in`, `delete`, and gOPD all consult ONE
mutable carrier, and retire the synthetic arms for that ctor. v2's own
constraint applies: **one ctor name per PR, each with its own regression
sweep** — this is a carrier-representation change with wide blast radius.

Suggested order: `Int8Array` first (largest test coverage via the 9 views ×
{length,name} — verify whether one `$__ta_ctor` carrier serves all views or
per-view carriers are needed), then `%TypedArray%` itself (the 14 statics).

Out of scope here (bounded point fixes, #2175 lane): the `$__ta_ctor`
property-access `.length`-answers-0 defect (~9 files) and the #4120 typeof
arm gap (`typeof Int8Array !== "function"`) — those don't need D7.

## Acceptance

Per-ctor PR: the delete/gOPD/`in` triple stays coherent through mutation;
the affected `{length,name}.js` files flip; zero regressions on the
TypedArray scoped suites + emit-identity where the static path is untouched.
