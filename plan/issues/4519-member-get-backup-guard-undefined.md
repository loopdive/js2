---
id: 4519
title: "standalone: member-get multi-struct backup guard answers a fallback instead of TypeError for `undefined.foo` — nullness-means-unset consumer #2 from #4489"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: member-access
goal: standalone-gap
related: [4489, 4484, 789]
origin: "2026-08-16 #4489 verification — the second #789 backup-guard site (property-access.ts ~L1500 member-get multi-struct dispatch) was deliberately NOT widened: it has a real fallback (wrong answer, not crash), and widening changes every member access on every undefined value."
---

# #4519 — member-get backup guard: undefined.foo doesn't throw

## Problem

`emitNullCheckThrow`'s sibling site — the member-get multi-struct dispatch
backup guard (`src/codegen/property-access.ts` ~L1500) — still tests
`ref.is_null` only. With the #4489 tag-1 undefined singleton active,
`undefined.foo` falls to the dispatch's fallback and answers a value
instead of throwing TypeError (§13.3.2.1 via §7.1.18 ToObject). #4489
widened the CRASH site (`emitIsNullishAnyAt` in any-helpers.ts — reuse it);
this site was deferred because its blast radius is every member access on
every undefined value and it wrongs rather than traps.

## Plan

Brief: plan/method/es5-standalone-agent-brief.md. Reuse
`emitIsNullishAnyAt` at the member-get backup site, gated
`undefinedSingletonActive`. The #4484 family-B rows
(property-accessors/S11.2.1_A3_*) are the acceptance rows; #4489's
corpus-sweep instrument (paired one-process A/B, stratified fixed-seed) is
the verification pattern — a scoped sweep is NOT sufficient for this one,
per the #4489 precedent (its crash-site twin was invisible to scoped
sweeps).
