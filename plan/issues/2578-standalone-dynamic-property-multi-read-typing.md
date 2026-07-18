---
id: 2578
title: "standalone dynamic property multi-read mangles inferred-typed values (writes fine, combined read → 0)"
status: done
assignee: dev-refactor
completed: 2026-07-17
sprint: current
created: 2026-06-21
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: objects, property access, type inference
goal: host-independence
related: [2542, 2515]
---

# #2578 — standalone dynamic-property multi-read mangles inferred-typed values

## Problem

Under `--target standalone`, reading two dynamic (`any`-typed) properties off an
open object and combining them in an inferred-typed expression yields `0`, even
though each property reads correctly in isolation. The descriptor **writes** are
correct — this is a **read-side type-inference** bug, in the #2542 dynamic
property read/write family (not the #2515 descriptor machinery, and not #2042
descriptor semantics).

Surfaced while draining #2515 S1 (`Object.create(o, descs)`), but it reproduces
on any open-object dynamic read, so it is filed separately.

## Reproduction (standalone)

```ts
// each property reads correctly in isolation:
Object.create(null, { x: { value: 3 }, y: { value: 4 } }); // o.x === 3 ✓, o.y === 4 ✓

// combined read into INFERRED-typed consts → 0 (WRONG, want 7):
export function test(): number {
  const o = Object.create(null, { x: { value: 3 }, y: { value: 4 } });
  const a = (o as any).x; // inferred (any/number?)
  const b = (o as any).y;
  return a + b; // → 0  (BUG)
}

// the SAME code with EXPLICIT `: number` annotations → 7 (CORRECT):
export function test(): number {
  const o = Object.create(null, { x: { value: 3 }, y: { value: 4 } });
  const a: number = (o as any).x;
  const b: number = (o as any).y;
  return a + b; // → 7  ✓
}
```

So:

- `return (o as any).x;` alone → 3 ✓
- `return (o as any).y;` alone → 4 ✓
- `const a=(o as any).x; const b=(o as any).y; return a+b;` (inferred) → **0** ✗
- same with `const a: number` / `const b: number` → **7** ✓

The explicit-annotation workaround pins it to **inferred-type lowering of a
dynamic `__extern_get` read** — the inferred local likely lands as the wrong
ValType (externref/boxed) so the `+` coerces both to a 0-ish scalar, or the two
reads alias the same temp. Writes and single reads are unaffected.

## Investigation pointers

- `src/codegen/property-access.ts` dynamic-read path (`__extern_get` → result
  ValType for an `any`/externref-typed binding).
- How an inferred `const a = <externref dynamic read>` chooses the local
  ValType vs an explicitly-`: number`-annotated one (the divergence point).
- Check for temp-local aliasing across two consecutive dynamic reads.

## Acceptance criteria

- [ ] The inferred-typed combined read returns 7 (matches the annotated form and
      host/gc mode).
- [ ] Single-property reads and descriptor writes remain correct (no regression).
- [ ] `--target gc` unchanged.

## Cross-links

- #2542 (standalone dynamic property read/write by computed key — same family)
- #2515 (surfaced here during S1; descriptor writes are correct, this is read-side)

## Resolution (2026-07-17)

Already fixed on current `main` — the bug does not reproduce. Every repro
variant now returns the correct value under `--target standalone`: the inferred
two-const combined read returns `7` (not `0`), matching the annotated form; a
single read returns `3`; three-read, inline-combined, open-object-literal-write,
and non-additive (multiply) combiners all return the right value.

The inferred-type lowering of a dynamic `__extern_get` read was repaired by the
dynamic property read/write family work (#2542 / #2515) after this was filed
(2026-06-21). Closed with a regression guard rather than a code change:
`tests/issue-2578.test.ts` (7 standalone cases) locks in the correct behavior so
the actively-churning dynamic-read path can't silently regress. No `src/` change.
