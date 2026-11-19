---
id: 7365
title: "Prepared: PhysicalModuleReservations re-audits every reservation on each query and fill (quadratic compile time)"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354]
---

# #7365 — PhysicalModuleReservations: quadratic layout audit

## Problem

Lane S3 (#7354 slice O) measured it: once the native realm is in a Prepared
module, one compile takes about 18 s, and 16 s of that is in
`PhysicalModuleReservations.#verifyLayout` / `#snapshot`. Every realm program
(slices O, Fa, Fb, C, B) pays this per compile, so it blocks the prelude
milestone's test budget. This is separate from the string-literal audit on
`claude/7354-perf2` (`assertNativeStringOutputRequirementsCurrent`,
`checkCompletedOwner`, `authenticateCensus`), which this issue does not touch.

## Measured (main `ee3fcdd610`, 2026-11-19)

### Where the cost is

`src/wasm/physical/module-reservations.ts`. `#verifyLayout()` (l.379) is a
full deep audit:

- every population array, slot by slot (`Object.hasOwn` + `Object.is`);
- the start publication and the canonical runtime rec-group (`dataText`);
- every reservation record (`#recordText`, `dataText`);
- every reserved type (`dataText` + its member identities);
- every filled function (`matchesPhysicalDataSnapshot` over its whole body);
- every filled global (`dataText` of its initializer);
- every publication (`dataText`).

It runs on every:

- `physicalIndex()` (l.761);
- `physicalIndices()` batch (l.798);
- `assertCompletedReservation()` (l.821);
- `#require()`, which is every reserve and every fill;
- `freezeReservations()`, `seal()`, `internFunctionType()` and imports.

`src/` has 154 `physicalIndex(` call sites outside the module and 12
`physicalIndices(` sites.

### Scaling (synthetic, `.tmp` bench)

N void functions are reserved. Each fill asks one index (its callee) and is
then filled with `call <index>`; after that N more index queries run.

| N | fill + index | index only, after fills |
|---|---|---|
| 250 | 397 ms | 268 ms |
| 500 | 1,846 ms | 1,211 ms |
| 1,000 | 6,676 ms | 4,506 ms |
| 2,000 | 29,267 ms | 22,193 ms |

Doubling N multiplies time by about 4.4: quadratic, with a per-audit cost
linear in the number of completed bodies.

### What the tests pin today (the contract)

43 test files name a reservation-audit failure. On main they hold 2,907
tests, 331 of which already fail (mostly `issue-3518-runtime-program-relocation`,
298). `tests/issue-3518-native-authentication-performance.test.ts` (green on
main) pins **fresh authentication per query**:

- "audits once per batch and never rereads the public ordinal after that
  audit" — "The next call must perform a fresh audit, whose getter mutation is
  detected": an empty `physicalIndices([])` must throw `altered completed
  function`.
- "refuses %s mutation on an unrelated resource after a previous successful
  batch" — nine kinds (body, locals, initializer, type, ordinal, population,
  `undefined`, hole, NaN bits). After one successful batch, an outside
  mutation must make the NEXT `physicalIndices([])` throw.
- "audits input reflection-trap mutations before computing any coordinates".

So "each pure query detects any outside mutation" is a pinned property, not
an accident. Any change that makes queries cheaper than a full audit breaks
those tests.

## Options

1. **Settled verdict per layout generation** (the brief's candidate).
   - A generation counter advances on every transaction-owned mutation. A pure
     query reuses the last verdict while the generation is unchanged.
   - An outside mutation is then caught at the next mutating call or at
     `seal()`, not at the next query, so the nine pinned tests move their
     expectation there.
   - Alone this is still quadratic: every fill is a full audit, so N fills
     cost O(N²). It needs option 3 as well to become linear.
2. **Deep-freeze owned data at capture.**
   - Completed bodies, initializers, type definitions and publications are
     frozen when the transaction captures them. An outside mutation then
     throws at its own site (strict mode) or is ignored (sloppy).
   - The audit reduces to identity checks, but the population slot loop is
     still O(N) per call.
   - It changes every pinned test from "detected later" to "throws at the
     mutation".
3. **Incremental audit.**
   - Each fill and reserve snapshots and checks only the data it adds, plus
     O(1) identity checks of the arrays it appends to.
   - The full deep audit runs once, at `seal()`, which production calls
     before emit (`src/ir/program-consumer.ts:1469`).
   - With option 1 for queries this is linear. The pinned tests move their
     expectation to the next fill or to `seal()`.
4. **Keep the contract and batch callers through `physicalIndices`.** This
   touches 154 sites across 20+ resource modules, and fills stay O(N) each, so
   it is still quadratic. Not recommended.

**Recommendation: 1 + 3.** Detection moves from "next query" to "next mutation
of the same resource, else `seal()`"; nothing reaches emit unaudited.

This changes a pinned guarantee, so it needs the lead's decision before code.
If chosen:

- the nine `…after a previous successful batch` tests assert at `seal()` (and
  at the next fill where the mutated resource is the fill's own);
- the ordinal-getter test asserts the getter is not re-read by a settled
  query;
- one new mutation test per folded check proves each kind is still caught
  at seal.

## Prototype of options 1 + 3 (2026-11-19, WIP on this branch)

- **Built:**
  - Queries (`physicalIndex`, `physicalIndices`, `assertCompletedReservation`)
    compute from private state settled at freeze, through one `#coordinate`
    helper: the reserved position plus the import offset of its index space.
    They read no public array.
  - Reserve and fill calls check only their own data.
  - `#verifyLayout()` (the full audit) runs at `freezeReservations()` and at
    `seal()`, and in `audited()`, which is unchanged (the perf2 lane's).
- **Synthetic bench, legacy fills:**

| N | fill + index before | after | queries after fill, before | after | freeze | seal |
|---|---|---|---|---|---|---|
| 250 | 397 ms | 3 ms | 268 ms | 0 ms | 3 ms | 5 ms |
| 500 | 1,846 ms | 3 ms | 1,211 ms | 0 ms | 3 ms | 5 ms |
| 1,000 | 6,676 ms | 4 ms | 4,506 ms | 0 ms | 6 ms | 13 ms |
| 2,000 | 29,267 ms | 11 ms | 22,193 ms | 0 ms | 8 ms | 21 ms |

- **Option 2 measured (owned fills, which copy and freeze at fill):**
  - On main, N=250 / 500 / 1,000: fill + index takes 1.5 s / 6.2 s / 23.9 s,
    and queries after fill take 0.3 s / 1.3 s / 5.6 s. They are as quadratic
    as legacy fills, because the per-query audit is O(N) per call whatever
    the body size.
  - With the prototype, at N=2,000, fill + index takes 48 ms.
  - Freezing is cheap, but it does not remove the quadratic term while
    queries keep auditing. Freezing legacy fills would also turn each pinned
    mutation into a TypeError at its own site.
- **Contract fallout:**
  - On the 43 pin files, 216 tests flip to failing (0 to passing): 547
    failing against 331 on main.
  - Every one expects detection at a query or at a fill of another resource.
  - Largest files: `issue-3518-physical-snapshot-comparison` 40,
    `issue-3527-publication-snapshot-comparison` 29,
    `issue-3527-descriptor-snapshots` 20,
    `issue-3518-native-primitive-wrapper-storage` 13,
    `issue-3518-native-authentication-performance` 11,
    `issue-3525-prepared-pipeline-boolean-presentation` 10,
    `issue-3518-native-number-primitive-classifier` 10.
  - Re-pointing these awaits the lead's decision.

## Implementation Plan (pending the decision above)

- **Module:** `src/wasm/physical/module-reservations.ts` only. The check
  functions stay where they are: `dataText`, `matchesPhysicalDataSnapshot`
  and the population loop.
- **Fold:**
  - `#verifyLayout()` splits into `#verifyOwn(token)` (the data one call adds
    or reads) and `#verifyAll()` (today's body).
  - `#verifyAll()` runs at `freezeReservations()`, at `seal()`, and wherever a
    test pins it after this decision.
  - Queries read a settled verdict keyed on a private generation, which only
    transaction methods advance.
- **No cache beside the checks:** the verdict is a boolean for the current
  generation. It is keyed on the transaction's own private state, which the
  checks already authenticate, not on public data.
- **Acceptance:**
  - compile time linear in reservations: the bench above at 3 sizes, before
    and after, on my own base run;
  - output bytes identical (Prepared tests that emit, plus a byte comparison
    of their binaries);
  - every forgery test still red on its mutation, at its new detection point;
  - the same pass/fail set as main on the 43 pin files, apart from the
    re-pointed expectations;
  - one new mutation test per folded check;
  - the realm compile from S3's `claude/7354-realm` before and after, once
    that branch exists.
