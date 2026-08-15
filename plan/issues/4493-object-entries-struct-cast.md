---
id: 4493
title: "Object.entries over a struct-typed record throws RuntimeError: illegal cast on the host round-trip"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

# #4493 — `Object.entries` struct round-trip: `illegal cast` at runtime

Found by the #4451 investigation (recorded in that issue's Results as an open
finding, pre-existing — reproduced on the compiler BEFORE the #4451 fix, so
not caused by it): once #4451 made the module VALID, the interface-typed
variant of its repro trips a runtime `RuntimeError: illegal cast`
(`WebAssembly.Exception`) in the host round-trip of a WasmGC struct through
`Object.entries`. Reproducible with **no callback at all**:

```ts
interface ExportSignature { arity: number; }
const sigs: Record<string, ExportSignature> = { a: { arity: 1 }, b: { arity: 2 } };
for (const [name, sig] of Object.entries(sigs)) {
  // touching `sig.arity` (or even just iterating) throws illegal cast
}
```

Mechanism sketch (verify, don't trust): `Object.entries` is serviced by the
host; the record's VALUES are WasmGC structs that get boxed to `externref`
for the host, and the tuple/element rebuild on the way back
(`buildTupleFromExternref` / the vec arms in `src/codegen/type-coercion.ts`)
`ref.cast`s the value back to the declared struct type. Something in that
round-trip presents the wrong carrier — either the outbound boxing loses the
GC identity (e.g. structs materialized into a host object become plain JS
objects, which can never cast back), or the inbound arm casts against the
wrong type index.

## Implementation Plan (Fable, 2026-08-15)

1. **Reproduce first**: the snippet above via `compileAndInstantiate`
   (harness pattern:
   `/home/user/js2wasm/.claude/worktrees/selfhost-baseline/.tmp/run-repro.mts`).
   Confirm `illegal cast`, and capture the WAT of the failing function to see
   WHICH cast fires (target type index + producing instruction).
2. **Decide which side is wrong** — this is the fork in the road, and it is a
   SEMANTIC decision, not just a codegen one:
   - If the host materializes struct values into plain JS objects (identity
     lost), then casting back is impossible BY CONSTRUCTION and the fix is on
     the consumer side: the rebuilt tuple's value slot must be treated as a
     host object (externref + dynamic property access), not re-cast to the
     struct. Follow how `Object.entries` results are TYPED by the checker
     lowering (grep the `Object.entries` handling in `src/codegen/` and the
     oracle's answer for the element type) — the element type decision is
     where the fix belongs.
   - If the host preserves the externref identity of the boxed struct
     end-to-end, the cast should succeed and the bug is a wrong type index in
     the rebuild arm — fix the index derivation.
3. **Check the sibling surfaces** once root-caused: `Object.values`,
   `Object.keys` (safe — strings), `for-in` over the same record, and the
   `#4451` interface-slot repro (its runtime-value assertion had to use the
   array-typed slot because of this bug — flip it to interface-typed as the
   regression test once fixed).
4. **Dual-mode**: verify what standalone mode does on the same snippet — if
   it has its own entries lowering that works, do not disturb it; if it
   shares the broken path, fix must cover both or explicitly scope to host
   with a documented standalone follow-up.
5. **Tests** (`tests/issue-4493*.test.ts`): the snippet above computing a
   value through `sig.<field>` (assert the right number, not just no-throw);
   an `Object.values` twin; and the #4451 interface-slot variant. A/B each
   against unpatched HEAD (must throw before, pass after).
6. **Scope guard**: if the root cause turns out to be the generic
   "structs lose identity across ANY host boundary" architecture issue
   (bigger than entries), STOP after root-causing, write Findings with the
   evidence, and leave status in-progress — that variant needs an
   architecture decision (it borders the value-representation goal), not a
   spot fix.

## Acceptance criteria

- [ ] Root cause documented: which cast, which side of the round-trip, and
      why.
- [ ] The repro computes correct values (or a documented STOP with findings
      if it is the architecture-level identity issue).
- [ ] Sibling surfaces checked and covered by tests where fixed.
- [ ] Typecheck + gates green; A/B'd collateral on coercion/tuple suites.
