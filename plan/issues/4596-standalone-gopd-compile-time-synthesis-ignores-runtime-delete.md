---
id: 4596
title: "STANDALONE: gOPD on a builtin prototype returns a SYNTHESIZED descriptor for a member deleted at runtime — has/delete/read agree, gOPD does not (#2885 Site-2 compile-time synthesis)"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: es5
related: [2885, 4492, 4163]
origin: "2026-08-21 wave-2 protos lane, found while fixing delete-of-named-proto-member. Deliberately NOT shipped with that fix because it moves zero rows in the lane — filed on correctness merits."
---

# #4596 — compile-time descriptor synthesis cannot see a runtime delete

## The disagreement

After `delete String.prototype.toString` (now working, `7b8410`):

| op | answer | correct? |
| --- | --- | --- |
| `hasOwnProperty("toString")` | `false` | yes |
| calling it | resurrection gone | yes |
| `Object.getOwnPropertyDescriptor(String.prototype, "toString")` — **literal member name** | a synthesized descriptor | **no — must be `undefined`** |
| the same gOPD call in FLOWING form (computed name) | `undefined` | yes |

## Cause — isolated by the flowing-vs-literal split

The #2885 Site-2 **compile-time** synthesis in
`src/codegen/expressions/call-builtin-static.ts:2726` builds the descriptor from
the immutable `$memberCsv` when the member name is a literal, so it cannot see a
runtime delete. The flowing form goes through the runtime path and answers
correctly — which is how the cause was isolated.

## Why it was not shipped with the delete fix

It moves zero rows in the protos lane, and the standing rule is that a working
fix that moves zero measured rows gets recorded, not shipped (the same call
#4492's Finding 2 made for the `toString` constant fold). It is a real
correctness bug on its own merits: three of the four MOP views agree and the
fourth lies.

## Fix sketch

Gate the Site-2 synthesis on the same `protoMemberDirty`/companion state the
delete fix consults — a module that never deletes a builtin-proto member keeps
the compile-time fold byte-identical; one that does gets the runtime path.

## Acceptance criteria

- Literal and flowing gOPD agree with hasOwnProperty after a runtime delete.
- A module with no proto deletes stays byte-identical (the fold is a measured
  win; do not remove it wholesale).
- Guard 551 clean; protowrite corpus isolated; GC-lane suites vs merge base.
