---
id: 7398
title: "Prepared: the allocation registry is copied and re-validated at every restore from the same snapshot"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354, 7365, 7397]
---

# #7398 — one validated restore per unchangeable allocation snapshot

## Problem

Found while profiling #7365. The Prepared requirement planners restore the
program's allocation registry with `AllocSiteRegistry.fromSnapshot`:

- `native-source-closure-requirements`;
- `native-object-access-requirements` (twice);
- `native-ref-cell-requirements`;
- `native-string-value-demands`;
- `native-number-format-requirements`.

On the prelude-shaped program of #7365 this happens 52 times per compile at
every size, always from the same snapshot. Each restore runs
`copyIrPreparationData`, which spends one Date probe and four collection
probes per object, each a thrown exception, and then re-asserts the
snapshot's shape. At the largest size (f) that is 6.4 s, 19 % of the compile.

## Implementation Plan

- **Module:** `src/ir/program/alloc-registry-restore.ts` (new, `ir-program`
  layer). `restoredAllocRegistry(snapshot)` is the planners' one restore
  entry, and the six callers switch to it.
- **`alloc-registry.ts` is not changed.** The `ir/analysis` layer may not
  import `ir/program`, so the settled verdict (#7354 Perf,
  `settled-verdict.ts`) is held where the callers are. And
  `tests/issue-3518-allocation-runtime-seam.test.ts` pins the
  `AllocSiteRegistry` class member by member.
- **Reuse:** `checkUnlessSettled`.
  - While a snapshot can still change, every call is today's full restore
    (`AllocSiteRegistry.fromSnapshot`).
  - Once it is deeply frozen (decided before the check), its one full
    restore is kept and later calls reuse it.
- **No shared mutable state:** callers get a frozen resolve-only view
  (`AllocSiteResolver`), because the caller audit shows that all six only
  call `resolve()`. The restored registry behind it is never handed out, so
  no caller can `alias` / `retire` / `annotate` it for another. The sites it
  resolves are copies of frozen data, so they are frozen too.
- **Contract:** neutral. A changeable snapshot is restored and re-validated
  at every use, as before.
- **Quality criterion:** one restore entry for the planners; no copy of the
  immutability walk; no change to the registry class.

## Measured (2026-11-19)

The prelude-shaped program, through `src/test262/test262-prepared-entry.ts`.
Each size is compiled 2× in one process.

| base | q | h | f | sha1 |
|---|---|---|---|---|
| `claude/7354-o` c0f3f288 | 32.6 / 32.4 s | 47.4 / 45.2 s | 84.9 / 91.7 s | 247da933 / 28148a80 / e6ec6c68 |
| `claude/7354-o` + #7398 | 31.7 / 31.2 s | 44.2 / 41.3 s | 82.8 / 87.5 s | identical |
| `claude/7354-o` + B′ + #7397 | 10.8 / 10.3 s | 17.7 / 16.7 s | 32.4 / 34.0 s | identical |
| `claude/7354-o` + B′ + #7397 + #7398 | 8.8 / 8.1 s | 13.3 / 13.0 s | 25.3 / 30.5 s | identical |

- Restore counts on q: 52 calls, of which 1 is a full restore.
- Without B′, the reservation audit of #7365 dominates. The `claude/7354-o`
  base row was measured on 53357b3b; c0f3f288 changes only gates.

## Acceptance criteria

1. Prelude q/h/f before/after, sha1 identical (above).
2. `tests/issue-7398-alloc-registry-restore-once.test.ts`:
   - a frozen snapshot is fully restored once, and every registry answers as
     the full restore does;
   - the view is frozen and resolve-only;
   - a mutable snapshot is fully restored at every use, and a mutation is
     refused;
   - a shared-prototype change re-validates.
3. The 68 test files that import the registry or the six planners: no new
   failures against `claude/7354-o`.
4. Gates: loc, func, coercion, oracle, dead-exports, import-cycles, and the
   compiler-boundaries inventory (the new module is classified `ir-program`).
