---
id: 7365
title: "Prepared: PhysicalModuleReservations re-audits every reservation on each query and fill (quadratic compile time)"
status: wont-fix
sprint: current
created: 2026-11-19
updated: 2026-11-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354]
# 2026-11-19 (part A, review round 1): src/ir/program-consumer.ts +7, the three `audited(() => { ... })` wrappers
# around the post-seal reader blocks (two lines each) and the one-line reason at the completion checks; they wrap
# reads in place, so there is no subsystem module to move them to. `materializePhysicalProgram` 300 → 303: the
# wrapper around its six completion checks is inline there at the reviewer's request (one caller).
loc-budget-allow:
  - src/ir/program-consumer.ts
func-budget-allow:
  - src/ir/program-consumer.ts::materializePhysicalProgram
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

## The realm program, and the split (2026-11-19)

Proving program of #7354 O (`function f(){ var o = { a: 1 }; return o.a; }
if (f() !== 1) throw 1;`), compiled three times through
`src/test262/test262-prepared-entry.ts`
(`wholeProgram: prepared-program-required`, wasmgc, standalone, `allowJs`).
The time is the second and third compile. The wasm is identical in all three
rows (sha1 `511adde20023d0a9591f97307d7bab532509a41d`).

| variant | compile |
|---|---|
| `claude/7354-realm` | 20.6 s |
| A: post-seal readers under one `audited()` each (no contract change) | 9.2 s |
| A + B: filling phase settled (B) | 1.5 s |

- **A, contract-neutral** (branch `claude/7354-perf3-readers`):
  - The pure readers after seal each run under ONE audit through the
    existing `audited()` instead of one audit per read. Those readers are:
    the completion checks after `seal()` in `materializePhysicalProgram`,
    `emittedSupportFunctionReceipts`, the support-receipt map and
    `nativeRealmCompletedSlots` in `recordEmissionObservation`.
  - `audited()` refuses any ledger mutation inside the block and audits once
    after it, so each reader still sees an audited layout.
  - Detection stays at the same calls, and no pinned test changes.
  - **Review round 1 (2026-11-19): an index is answered from private state.**
    Inside a block the nested audits are skipped, so a public layout altered
    during one read and restored before the exit audit could steer
    `physicalIndex` (it counted `module.imports` and read
    `module.funcOrdinalToPosition`). `physicalIndex` and `physicalIndices`
    now share `#coordinate`: the reserved position plus the import offset of
    its index space, counted from the reservation tokens at freeze. Every
    audit call stays where it was. Probes:
    `tests/issue-7365-audited-reader-forgery.test.ts`.
- **B, contract change** (branch `claude/7354-perf3-reservations`, on top of A):
  - During filling, queries read private state settled at freeze, and each
    fill checks only its own data.
  - The full audit runs at freeze and at seal, and every read after seal
    still audits.
  - 186 pinned tests move their detection point, from a query or another
    resource's fill to the next fill of that resource or `seal()`.
  - It waits for the project lead's OK on that contract change.
- **Profile of A + B:** what is left is mostly realm inventory work
  (`nativeRealmReservationInventory`, `preparedIrDataMismatch`), not this
  audit.

## Chosen: B′ (lead decision 2026-11-19)

**Contract.** An index query during filling does not audit the layout;
completion checks, freeze and seal do, and every read after seal does. A
reservation's own data is checked when it is reserved or filled. The same
sentence is in the header of `src/wasm/physical/module-reservations.ts`.

- **Completion checks** are `assertCompletedReservation`,
  `assertTypeReservation` and every `requireCompleted*` that reaches them. They
  keep their full audit during filling. Only `physicalIndex` /
  `physicalIndices` and reserves / fills skip it.
- **Nothing is emitted from an unsealed layout.**
  - The one production owner of a transaction (`src/ir/program-consumer.ts`,
    `materializePhysicalProgram`) has no return before `seal()`. Its module is
    exposed only through the emission it returns after sealing.
  - After a refusal the ledger is `failed` and `seal()` refuses. Every
    re-pointed pin asserts that (`expectUnemittable`).
- **Owned fills** (`fillOwnedFunction`) keep their fill-time check of their own
  descriptor and completed body (`#verifyDescriptor`,
  `#verifyCompletedFunction`). `#verifyLayout`'s per-token loops now call the
  same two helpers.
- **Realm proving program:** A 9.2 s, B′ 3.1 s (B would be 1.5 s). The wasm is
  identical in every variant (sha1 `511adde2`).

### Pins re-pointed by B′ (65; the src commit alone fails exactly these)

| file | re-pointed | old detection point | new detection point |
|---|---|---|---|
| `issue-3518-physical-snapshot-comparison` | 40 | `physicalIndices` during filling | `queryAfterAudit` (one completion-check audit, then the query) |
| `issue-3518-native-authentication-performance` | 11 | `physicalIndices` during filling | `queryAfterAudit`; the reflection-trap pin `completionCheck` |
| `issue-3518-native-string-flatten-resources` | 6 | `requireCompletedNativeStringFlatten` (its index queries) | `completionCheck` (the check under `audited()`) |
| `issue-3518-native-builtin-functions` | 3 | `requireNativeBuiltinFunctionReservations` | `completionCheck` |
| `issue-3518-builtin-request-literal-authentication` | 2 | the issuer, filling phase | `completionCheck` (reserving keeps the issuer) |
| `issue-3518-native-string-completion` | 2 | `requireCompletedNativeStringLiterals` | `completionCheck` |
| `issue-3527-owned-function-data` | 1 | `fillOwnedFunction`'s whole-layout closing audit | `sealed` |

Every re-pointed pin keeps its mutation and its expected error text.
`scripts/check-pinned-refusals.mjs --base <A head>` verifies this per file:
the same expected refusals, the same case count, no added `.not.toThrow`.

### Possible later change: B

B would also skip the audit in completion checks during filling (realm
1.5 s). It moves 186 pins, across the #3518, #3525 and #3527 suites. Not
built.

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

## Full-prelude measurement (2026-11-19)

S1's full-prelude stand-in (`claude/7354-fn-standin-research` 23c7f9ec0c):
`t3.mts` on assert.js + sta.js + `S7.9_A6.1_T2.js`. One compile per process,
4-core box, output sha1 e185e243 identical in every row.

| tree | compile |
|---|---|
| base 23c7f9ec | 1,002 s |
| base + B′ + #7397 + #7415 | 967 s |
| + #7436 (experiment) | 475 s |

On this program B′ is not the lever. The dominant cost is the per-literal
re-derivation that #7436 settles. The #7436 issue file has the profile and
the reproduction notes:

- `CENSUS_STUBS=s0,s1,toprim,tostr-fn,mcall,dyn.json_stringify,dyn.member_get,dyn.object_tag`;
- `FN_STANDIN_C1=1`;
- run `t3.mts` from `.tmp/`.

## Suspended Work (2026-11-20, budget window closed)

- **Branches:**
  - B′ is `claude/7354-perf3-reservations` c0433660ba;
  - A is `claude/7354-perf3-readers` aba5c035.

  Neither has a PR. B′ is blocked by review RV7365Bb
  (loopdive/js2#7312, comment 7017721630) and also needs the project lead's
  OK.
- **Blocker evidence, partial.** A (aba5c035) vs B′ (c0433660), each of the
  333 test files that touch the reservation API run in its own process. 315
  files were compared; 18 `issue-7354-*` files did not finish on A. 17 tests
  newly fail on B′, all `expected [Function] to throw`:
  - `issue-3518-closure-coordinate-audits`: 5;
  - `issue-3518-native-string-number-resources`: 9;
  - `issue-3518-native-string-types-split`: 2;
  - `issue-3518-native-invocation-substrate`: 1 ("canonical substrate
    completion detects post-completion carrier mutation"). This one is new;
    the reviewer's subset did not include it.
- **Next steps:**
  1. Finish the 18 remaining files on A.
  2. Re-point each newly silent pin to `completionCheck` / `sealed` plus
     `expectUnemittable`, the same as the other 65.
  3. Correct the contract sentence to: "an index query during filling does
     not audit; `assertCompletedReservation` / `assertTypeReservation`,
     `audited` blocks, freeze and seal do". A `require*` check that reads
     only indices is therefore caught at seal.
  4. State in `check-pinned-refusals.mjs` that it guards re-pointing edits
     only, and attach the per-file run as the evidence for untouched files.
  5. Write option (c), the incremental `#verifyLayout` (7.5 s, 25 % on the
     synthetic f), as a proposal next to B′, per the lead.
- **Open review threads:** RV7365Bb blocker (above), and its two nits: the
  read-parity test in `issue-7365-filling-query-private-state`, and the
  double phase check in `physicalIndices`.

## Superseded (2026-11-26)

Closed as superseded by #7354 Perf3–Perf6, merged to main on 2026-11-21/22. On
main 6694a8b839, the full-prelude program (source sha1 c70fb78b, S1's `t3.mts`)
compiles in 3.6–4.2 s, peak RSS about 580 MB, and the output runs. On
2026-11-20 it took 1,002 s (base) and 475 s with #7436. Perf6 checks a native
string plan as issued instead of re-planning it for each literal, which removes
the per-literal re-derivation measured above. No PR was opened from this
branch.
