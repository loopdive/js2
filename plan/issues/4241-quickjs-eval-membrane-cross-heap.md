---
id: 4241
title: "QuickJS eval membrane — live cross-heap object access both directions + cycle-safe lifetimes (gc_mark), replacing slice-2's copy/box tier"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4236, 4238, 4242]
blocked_by: [4238]
# id 4241 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable; pr_scan=degraded). Equivalent open-PR scan
# via the GitHub MCP at reservation time: sole open PR was PR 4250 (#4238
# slice 1, edits the existing 4238 issue file, introduces no new issue ids).
# The id coincides with a merged PR number — shared sequence, not a namespace
# (precedent: 4235/4236/4237).
---

# #4241 — QuickJS eval membrane: live cross-heap objects + cycle-safe lifetimes

## Why (the gap #4238 deliberately leaves)

The #4238 MVP bridges primitives by copy, surfaces QuickJS functions as
callable carriers, boxes non-callable QuickJS objects opaquely, and refuses
compiled GC objects crossing inward with a typed TypeError. That is correct
for the MVP but is NOT parity with the Acorn+interpreter provider, which
shares the WasmGC heap and therefore gives eval'd code **live** access to
compiled objects — identity-preserving reads AND writes.

Replacing the interpreter as the default engine (#4242) requires the
membrane: objects crossing the seam must be **live views, not copies**, in
both directions.

## Scope

1. **Inward (compiled GC object → visible inside QuickJS eval'd code)**:
   exotic wrapper via `JSClassDef` — per-property `get`/`set`/`has`/
   `delete`/`ownKeys` traps that call back through the seam into GC-lane
   accessor exports. Identity: the same GC object wraps to the same QuickJS
   object within a context (wrapper table). This is the #4236 variant C
   design; the browser-JS↔DOM precedent and the trap inventory are recorded
   there — architect to turn it into an implementable trap↔seam-export map.
2. **Outward (QuickJS object → compiled code)**: upgrade slice-2's opaque
   handle box to a live view — property get/set through seam helpers
   (dynamic-access paths only; typed code cannot hold these except behind
   `any`, which is exactly where the codegen already emits dynamic MOP
   calls). Same-handle → same-box identity.
3. **Cycle-safe lifetimes**: implement the `JSClassDef.gc_mark` hook so
   QuickJS's cycle collector can see wrapper→GC-handle edges; define and
   implement the release protocol for both tables (wrapper table inward,
   box table outward) so a dropped cycle spanning both heaps is collected.
   Replace slice-2's documented context-lifetime retention of function
   carriers with the same mechanism.
4. **Leak accounting**: a debug/assert mode that reports live wrapper/box
   counts per context (test hook), so the lane tests can assert
   allocate→drop→collect actually reclaims.

## Hard constraints

- All #4238 constraints carry over: flag-gated only, default path
  byte-identical, 4-import seam ABI frozen (new capability arrives via NEW
  provider-internal exports/imports between adapter and artifact, never by
  changing the user-module seam), zero JS behind the seam, borrow
  discipline.
- **The interpreter provider and everything it depends on (src/interp/,
  its IR/codegen substrate, acorn) are UNTOUCHED** — project-lead directive
  2026-08-08: the migration keeps the interpreter fully working behind
  `JS2WASM_EVAL_ENGINE=interpreter`; no removals, ever, in this issue.
- quickjs-ng stays pinned (v0.16.1 / 954dc536); shim additions only.

## Acceptance criteria

- [ ] A compiled GC object passed (via a runtime-assembled name) into
      eval'd code can be READ and WRITTEN there, and the compiled side
      observes the writes — identity preserved across multiple evals.
- [ ] An object created inside eval, returned to compiled code, mutated by
      a later eval, shows the mutation to compiled-side dynamic reads.
- [ ] Function carriers and object boxes no longer retain for context
      lifetime: the leak-accounting hook shows reclamation after drops,
      including a cross-heap cycle (GC object ↔ QuickJS object referencing
      each other, both dropped).
- [ ] The #4238 test lane extended with membrane cases; all green under
      `JS2WASM_EVAL_ENGINE=quickjs`; default-path suites untouched and
      green with no env set.
- [ ] Residuals honestly enumerated in this file (e.g. exotic-wrapper
      visibility limits: `Object.getOwnPropertyDescriptor` fidelity,
      prototype-chain crossing, `instanceof` across heaps).

## Implementation Plan

(To be written by architect — trap↔seam-export map, wrapper/box table
design and identity rules, gc_mark protocol, release/refcount state
machine, slice order sized for one Opus implementer per slice.)
