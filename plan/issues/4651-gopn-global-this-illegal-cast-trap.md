---
id: 4651
title: "standalone: Object.getOwnPropertyNames(this) TRAPS with illegal cast at module top level — uncatchable, kills the whole module"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: object-mop
goal: standalone-gap
related: [4491, 4643]
origin: "dev-4491 wave-4 triage (2026-08-23): found while clustering the getOwnPropertyNames census row; reported to the lead, filed by the lead. Trap class — same severity family as the #4639/#4637 fn-proto trap (uncatchable, module-killing)."
---

# #4651 — Object.getOwnPropertyNames(this) illegal-cast trap

## Problem (reported by dev-4491, wave-4 triage)

`Object.getOwnPropertyNames(this)` at module top level in standalone
traps with `illegal cast` — uncatchable, the module dies. The
top-level `this` (the global-this stand-in) reaches a
`getOwnPropertyNames` arm that `ref.cast`s it to a shape it does not
have.

**Scope correction (dev-4491, same day):** the census row
`built-ins/Object/getOwnPropertyNames/15.2.3.4-4-1.js` does NOT root
here — it runs to completion and fails its assert because the global
object exposes no own function properties (`gOPD(this,"eval")` →
undefined while `Math.abs`/`Array.prototype.push` answer correctly);
that is a #4491 carrier-coverage residual. The trap reproduces in a
module that ALSO reads global members through a helper (dev-4491's
probe shape). This issue owns only the trap; no conformance row is
currently attributed to it.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding).
2. Reproduce with a direct compile probe (`.tmp/`), read the WAT: find
   the arm that casts the receiver. Expect a naked
   `any.convert_extern; ref.cast $Object` (or $__vec) on a receiver that
   is the global-this marker — the same pattern the lead fixed at
   `__extern_get`'s fnctor-proto-start arm (test-before-cast,
   src/codegen/object-runtime.ts ~L2079, #4639/#4643 record).
3. Fix trap-first: `ref.test` before the cast, graceful arm for the
   non-$Object receiver. Then decide the CORRECT answer for global-this
   enumeration (own property names of the global object): if a real
   implementation is out of scope, return the names the standalone
   global actually tracks and record the residual — absent-not-wrong,
   never trap.
4. Pins: tests/issue-4651.test.ts — the pin must EXECUTE
   `Object.getOwnPropertyNames(this)` and consume the result
   (pin-exercises-the-shape rule); verified failing on base.
