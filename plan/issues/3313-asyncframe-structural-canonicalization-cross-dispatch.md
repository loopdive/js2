---
id: 3313
title: "Driven async-gen consumer misdispatches when two producers' $AsyncFrame structs are structurally identical (WasmGC canonicalization)"
status: ready
sprint: Backlog
priority: medium
feasibility: hard
model: fable
task_type: bug
area: codegen
language_feature: async-generators
goal: standalone-mode
horizon: m
related: [3132, 2865, 2906]
created: 2026-07-16
origin: "#3132 S2 probing — pre-existing on main: two identical zero-param fn-decl async gens in one module already misdispatch."
---

# #3313 — same-shape $AsyncFrame types canonicalize equal → ref.test switch hits the first producer

## Problem

The driven async-gen CONSUMER paths (the generic `__iterator`/`__iterator_next`
ASYNCGEN arm and the `.next()` runtime dispatch in calls.ts) select the
per-producer `__async_gen_next_<stem>` helper via a `ref.test` type-switch over
`ctx.asyncGenProducers` (stateTypeIdx → helper). WasmGC canonicalizes
iso-structural rec groups: two `$AsyncFrame_<stem>` structs with identical
field lists (e.g. two zero-param, zero-spill async gens — or two methods whose
receiver classes have identical shapes) are THE SAME canonical type, so
`ref.test` matches the FIRST registered arm and the second generator runs the
first generator's driver.

Repro (PRE-EXISTING on main, standalone):

```ts
let n = 0;
async function* g1() { yield 4; }
async function* g2() { yield 5; }
function go() {
  var ia = g1(); var ib = g2();
  async function fn() {
    for await (const v of ia) { n += v; }
    for await (const v of ib) { n += 10 * v; } // delivers 4, not 5
  }
  fn();
}
export function test() { go(); return n; } // 44, want 54
```

(Direct-call consumers that resolve statically via
`resolveAsyncGenNextHelperName` are unaffected; the bug needs the runtime
type-switch — var-held frames, multiple for-awaits in one fn, etc.)

## Fix directions

- Store an immutable per-producer ID field in the frame struct and switch on
  `struct.get` of the ID (needs a common readable supertype or a two-step
  cast), instead of type identity; or
- make frame types nominally distinct (single-rec-group type section or a
  distinct brand field per producer); or
- correct-or-legacy: detect layout collisions at registration (serialize the
  field valtypes) and fall the SECOND producer to the legacy buffer — cheap but
  de-drives common shapes (any two plain async gens in one module), so
  measure first.

## Acceptance

- The repro returns 54 host-free.
- No de-drive of the multi-async-gen corpus (or a measured, accepted trade).
