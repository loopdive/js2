# `as unknown as Instr` cast inventory

Generated: 2026-05-20 by `scripts/audit-instr-casts.mjs`.

The cast `as unknown as Instr` bypasses TypeScript's instruction union and allows arbitrary opcode strings to flow into the Wasm emitter. Issue #1526 audited every site and removed the gratuitous casts (every op was already in the union — the casts were habitual style). `scripts/instr-cast-baseline.json` tracks the ceiling enforced by CI.

**Total occurrences:** 0

All call sites use the typed `Instr` union directly. New casts will fail the `Instr cast budget` CI check unless the baseline is updated.

## Top files

_(none)_

## Ops with > 10 casts (high priority)

_(none)_

## Ops with 2-10 casts (medium)

_(none)_

## Ops with 1 cast (long tail)

_(none)_
