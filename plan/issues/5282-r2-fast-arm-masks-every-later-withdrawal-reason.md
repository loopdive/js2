---
id: 5282
title: "R2 fast-mode admission masks every later withdrawal reason — the 20-reason vocabulary collapses to one, and R2-E1 is blocked on it"
status: done
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
sprint: current
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
area: ir
goal: backend-agnostic-ir
requested_by: ttraenkler/fable-ir-takeover
related: [3521, 3518, 2856]
# (#5282, 2026-09-03) The fix separates the DECIDING predicate from the NAMING
# predicate inside `selectR2PreparedOwnerComponents`. The deciding `find` line is
# byte-identical, which is the acceptance criterion — so the change cannot be
# made smaller by deleting the second scan, and the comment that states WHY
# re-ordering was rejected is the load-bearing part a future reader needs
# (R2-T1's own comment forbids re-ordering). +16 lines, ~8 of them that comment.
loc-budget-allow:
  - src/codegen/ir-prepared-free-functions.ts
---

## Problem

#3521 R2-T1 landed a 20-member withdrawal-reason vocabulary
(`src/ir/r2-withdrawal.ts`) so that a unit refused by the R2 admission chain
records *why*. In **fast mode that diagnostic value collapses to a single
reason**, and the collapse is structural rather than incidental.

`selectR2PreparedOwnerComponents` reads its predicates from an ordered table
and picks the first that fires:

```ts
// src/codegen/ir-prepared-free-functions.ts:1354-1366
// (#3521 R2-T1) The same ten predicates in the same order, read as a table
// so the FIRST failing one can be named. `find` short-circuits exactly like
// the `||` chain it replaces, so no predicate that used to be skipped runs.
const admissionPredicates = [
  ["fast-signature-unproven", () => input.ctx.fast && !( … )],
  ["async-declaration", () => isAsync],
  …
];
```

`fast-signature-unproven` is **entry zero**, and its guard is `ctx.fast && !(any
fast predicate admits)`. So in a fast lane every refusal answers
`fast-signature-unproven`, and `async-declaration`,
`param-signature-unstable`, `allocated-slot-mismatch` and the rest are
unreachable — not because they are wrong, but because they never run.

Measured on PR #5507 (R2-F1): **all 32 residual fast-lane rows read
`admission:fast-signature-unproven`**, both before and after that slice. It is a
property of R2-T1's table ordering, not of any later slice.

## Why it matters now

1. **R2-E1 is blocked on it.** Extern/reference-carrier certification needs to
   tell a reference-carrier refusal from any other fast-mode refusal. By reason
   alone it cannot: they are the same string. #5507's checkpoint records this
   explicitly as a consequence for R2-E1, and notes the only workarounds
   available today are reading the non-fast lanes' reasons instead, or
   re-ordering the table.
2. **It silently weakens pins.** `tests/issue-3521-r2-withdrawal-shapes.test.ts`
   pins one shape per reachable reason. #5507 had to re-point the
   `fast-signature-unproven` pin from `len(s: string): number` (which that slice
   admits) to `op(o: { a: number }): number`. The new pin is correct but weak —
   with the masking, *any* fast-mode refusal satisfies it, so it cannot
   distinguish a reference-carrier refusal from a shape refusal. #5507's own
   non-vacuity revert shows the symptom: dropping the new disjunct leaves that
   suite 8/8 green.
3. **The vocabulary is a #3518 instrument.** R2's telemetry is how the spine
   reports admission progress. A denominator that reports one reason for a whole
   lane cannot support the per-bucket ratchet #2855 is built around.

## Acceptance

- A fast-lane refusal records the reason that actually describes it. Whether
  that is achieved by moving the fast arm later in the table, by splitting it
  into per-family reasons, or by recording a secondary reason alongside it, is
  the implementer's call — but the choice must be justified against
  order-preservation: R2-T1's comment states `find` short-circuits *exactly*
  like the `||` chain it replaced, so re-ordering changes which predicates run
  and is **not** free. Prove admission decisions are unchanged (the set of
  prepared units must be byte-identical); only the recorded reason may move.
- `tests/issue-3521-r2-withdrawal-shapes.test.ts` gets a fast-lane shape per
  newly-reachable reason, and the `fast-signature-unproven` pin is re-pointed at
  a shape only *it* can explain.
- The non-vacuity revert that #5507 recorded as passing (drop the F1 disjunct →
  shapes suite still 8/8) must **fail** afterwards, or the pins are still blind.

## Provenance

Found while reviewing PR #5507 on 2026-09-03 and verified directly against
`ir-prepared-free-functions.ts:1354-1366` rather than taken from the lane's
report. The R2-F1 lane discovered it independently, recorded it as a
contradiction of its own plan's P2 expectation, and correctly declined to fix it
in that slice — re-ordering R2-T1's table is R2-T1's contract, not R2-F1's. This
issue exists so the finding is not lost in a merged PR's checkpoint note.

---

## Implementation Plan

Written 2026-09-03 (architect lane). Figures labelled **measured** were produced
in a worktree at `origin/main` `bee5ddd535`.

### Shared vocabulary — R2 accounting cluster (#5262 / #5263 / #5282 / #5283)

Identical block in all four plans. Use these words; they are not synonyms.

| term | meaning |
| --- | --- |
| **direct receipt** | one `compileFunctionBody` entry indexed by `IrBodyRouteAuditSession.#indexDirectFunctionBodyReceipt` (`src/codegen/legacy-body-audit.ts:303`). The ONLY source of `directBodyEmissions`. Recorded **only** for top-level free-function terminals. |
| **physical root** | any `IrLegacyBodyEntry` carrying a `unitId` — a superset of direct receipts that also includes `compileClassBodies`, `compileModuleInitBody`, `compileStatement`, `compileExpression`. |
| **the triple** | `(prepareAttempts, directBodyEmissions, irBodyEmissions)`. Present **only** on rows in the R2 population; absent (not zero) everywhere else. |
| **R2 population** | `indexR2FreeFunctionPopulations` (`ir-overlay-outcomes.ts:153`) — source-local, public, physical, last-named top-level function declarations with bodies. |
| **accounting arm** | one `if` branch inside `functionBodyAccountingFailure` (`ir-overlay-outcomes.ts:315-358`). |
| **root-cause outcome** | the outcome the precedence chain at `ir-overlay-outcomes.ts:905-967` computed, *before* the accounting block at `:969-978` runs. |
| **owned-elsewhere unit** | a terminal whose ledger row is minted by the prepared-callable publication path, not by `reconcileIrOverlayOutcomes`. See #5263. |

Two additional terms this issue needs:

- **deciding predicate** — the entry `admissionPredicates.find(...)` returns.
  It, and only it, determines admission.
- **naming predicate** — the entry whose literal is recorded as the reason.
  Today these are forced to be the same object; the fix separates them.

### Root cause — confirmed by A/B measurement

Two compiles of one source, `fast: true` vs `fast: false`, reading
`r2WithdrawalOf(outcome)`:

| unit | fast lane reason | non-fast lane |
| --- | --- | --- |
| `objParam(o: { a: number }): number` | `admission:fast-signature-unproven` | `admission:param-signature-unstable` |
| `asyncFn(x: number): Promise<number>` | `admission:fast-signature-unproven` | admitted via the R3 suspending-async route (no withdrawal) |

**Same unit, same refusal cause, two different recorded reasons depending on the
lane.** That is the masking in one pair, with no interpretation needed. It is a
property of the table's ordering at `src/codegen/ir-prepared-free-functions.ts:1475-1514`,
where `fast-signature-unproven` is entry zero and its guard is
`ctx.fast && !(any of the three fast signature proofs admits)`.

Scope note the issue does not state: a withdrawal reason is only ever
**observable** on a compile-twice `(1, 1, 1)` row — `r2WithdrawalDefect`
(`src/ir/r2-withdrawal.ts:115`) rejects a reason on any other shape, and
`reconcileIrOverlayOutcomes:945-951` only attaches one there. Measured
consequence: in the same probe, `genFn` and `valueRef` were withdrawn with
`(1, 0)` and carry **no reason at all**. Widening that is out of scope here, but
any "one shape per reason" pin must be built from a shape that actually reaches
`(1, 1, 1)`, or it will assert against `undefined`.

### Design — separate the deciding predicate from the naming predicate

The acceptance criterion demands admission be **byte-identical**. Re-ordering
the table cannot give that for free: `find` short-circuits, so moving the fast
arm later makes predicates run that previously did not, and at least
`r2SignatureMatchesAllocatedSlot` and `containsUnplannedNestedExecutableSyntax`
read compiler state (**reasoned** — the implementer must confirm they are pure
and non-throwing before relying on it).

The order-preserving construction: leave the deciding `find` exactly as it is,
and compute the recorded reason afterwards, on the already-refused path only.

**File: `src/codegen/ir-prepared-free-functions.ts`, `selectR2PreparedOwnerComponents` (~`:1515-1519`)**

```ts
const firstFailing = admissionPredicates.find(([, rejects]) => rejects());
if (firstFailing) {
  // (#5282) The DECISION above is untouched — `find` short-circuits exactly as
  // before, so the prepared set is byte-identical. Only the NAME moves: the
  // fast arm is entry zero and its guard subsumes every later predicate, so in
  // a fast lane it answered for refusals it does not describe. The unit is
  // already refused here, so evaluating the remaining predicates cannot change
  // admission — it can only find the reason that actually fits.
  let reason = firstFailing[0];
  if (reason === "fast-signature-unproven") {
    const specific = admissionPredicates.slice(1).find(([, rejects]) => rejects());
    if (specific) reason = specific[0];
  }
  record(unitId, "admission", reason);
  continue;
}
```

Why this over the alternatives:

- **Re-ordering the table** changes which predicates run on the *admitted* path
  too, and is exactly what R2-T1's comment warns against. Rejected.
- **Splitting `fast-signature-unproven` into per-family reasons** grows the
  closed vocabulary and still leaves `async-declaration`,
  `nested-executable-syntax` and the rest unreachable in fast mode. It solves a
  smaller problem. Rejected as the primary fix; may be a follow-up if R2-E1
  needs a *reference-carrier* reason specifically.
- **Recording a secondary reason alongside** requires widening `IrR2Withdrawal`
  and `r2WithdrawalDefect`, which is #3521 R2-T1's contract. More surface, same
  outcome. Rejected.

Update R2-T1's comment above the table so it stays true: `find` still
short-circuits the decision; a second scan runs only after refusal.

### The reachability problem this creates — decide it explicitly, do not discover it in CI

Under this design `fast-signature-unproven` is recorded **only** when no other
predicate fails, i.e. when the fast signature proof is the sole objection.
**Measured: the existing pin no longer qualifies.** `tests/issue-3521-r2-withdrawal-shapes.test.ts:89-106`
pins `op(o: { a: number }): number` — which the non-fast lane refuses as
`param-signature-unstable`, so after this change the fast lane will say the same
thing and that test will fail.

I searched for a replacement and **did not find one**: `strFn(x: string): string`,
`vecFn(v: number[]): number`, `boolFn(b: boolean): boolean` and `scalar` are all
*admitted* in both lanes (measured, across `nativeStrings` on and off), and
`mixed(a: number, s: string): string` is refused in both lanes with `(1, 0)` —
so it carries no reason to assert on. That is four shapes, not an exhaustive
search; it is enough to say the pin is not obvious.

The implementer must pick one and say so in the PR:

- **(a)** find a shape the fast proofs reject and every later predicate accepts —
  most likely an opaque-host `externref` carrier or a generator with
  `allowOpaqueExternrefValue`, since those are admitted by
  `r2StableSignatureType` but not by the three fast proofs. Re-point the pin.
- **(b)** if no such shape exists, `fast-signature-unproven` is unreachable and
  must be **removed from `IR_R2_WITHDRAWAL_REASONS`** in the same PR, with
  `r2WithdrawalDefect`'s closed-set check and the shapes suite updated together.
  Leaving an unreachable member in a closed vocabulary is the same class of
  defect this issue is about.

Do not resolve this by weakening the pin to "any fast-mode refusal" — that is
the exact vacuity #5507 recorded.

### Non-vacuity — a reason pin can never catch an admission regression

The issue asks that #5507's revert (drop the F1 disjunct → shapes suite still
8/8) must FAIL afterwards. **A reason pin alone cannot deliver that**, and the
plan should not pretend otherwise: dropping `r2FastMixedFixedCarrierSignature`
moves a previously-*admitted* family into the refused set, and refused units are
not asserted by any reason pin.

What does deliver it: a **positive** pin. Add to
`tests/issue-3521-r2-withdrawal-shapes.test.ts` a test that the F1-admitted
shape produces `(directBodyEmissions, irBodyEmissions) === (0, 1)`, a
`preparedComponentId`, and **no** withdrawal record — mirroring the existing
`plain` control row at `:83-86`. Dropping the F1 disjunct then flips that row to
`(1, 1)` with a withdrawal and the suite goes red. State in the PR that this,
not the reason pin, is what closes the vacuity.

### Ordering constraints

**Fully independent of #5262 / #5263 / #5283.** Those three all live in
`src/codegen/ir-overlay-outcomes.ts` + `src/codegen/index.ts`; this one touches
only `src/codegen/ir-prepared-free-functions.ts` and
`tests/issue-3521-r2-withdrawal-shapes.test.ts`. No shared symbol, no shared
line. It can land first, last, or concurrently.

**Lane hazard, not a code conflict:** `ir-prepared-free-functions.ts` is R2's
file and #3521 R2-T1 / #3522 R3 are actively owned by other lanes. Claim the
issue before starting and keep the diff inside
`selectR2PreparedOwnerComponents`'s refusal branch; do not touch the fixed-point
table at `:1562-1619` or the R3 functions above it.

### PR grouping

**#5282 alone, in its own PR** — it is the only one of the four that does not
touch `ir-overlay-outcomes.ts`, and bundling it would put an R2-owned file into
a PR two other lanes need to review for a different reason.

### Edge cases

- **Throwing predicates.** The secondary scan runs predicates the fast arm used
  to short-circuit past. If any throws on a unit the fast arm rejected, the
  compile now fails where it previously succeeded. That is a real finding, not
  something to swallow: do **not** wrap the scan in a `try`. Run the corpus
  (below) and report anything that throws.
- **`baseline.has(unitId)`** units skip the table entirely (`:1461-1464`);
  unchanged.
- **Generators** carry `signatureOptions.allowOpaqueExternrefValue`, so the
  secondary scan's `param-/return-signature-unstable` predicates must be
  evaluated with the same `signatureOptions` object already in scope — they are,
  since the closures capture it. Do not rebuild them.
- **`generator-lane`** only fires when `!generatorsPreparable(ctx)`, which is
  lane-dependent; a generator in a fast lane where generators *are* preparable
  should fall through to a signature reason, not to `generator-lane`.

### Acceptance measurements

1. **Admission unchanged — the load-bearing one.** Before and after, for every
   entry in `SINGLE_HOST_ENTRIES` and `STANDALONE_ENTRIES` plus a fast-lane
   corpus, dump the prepared free-function name set and assert byte equality.
   `pnpm run check:ir-only` READY with `scripts/ir-only-baseline.json`
   **unchanged** is the cheap version of this; the explicit set diff is the
   honest one. Record both.
2. `objParam(o: { a: number }): number` records `admission:param-signature-unstable`
   in the fast lane, identical to the non-fast lane (measured before: it did not).
3. `asyncFn(x: number): Promise<number>` in a fast lane where R3 does not
   re-admit it records `admission:async-declaration`, not
   `fast-signature-unproven`.
4. `tests/issue-3521-r2-withdrawal-shapes.test.ts` green, with the
   `fast-signature-unproven` pin either re-pointed per (a) or the reason retired
   per (b) — and the PR says which, with the search that justified it.
5. The new positive F1 pin exists and the #5507 revert (drop the F1 disjunct)
   turns it red. Record the revert run.
6. Report the fast-lane reason histogram before and after. Before (per the
   issue): 32/32 rows `fast-signature-unproven`. After: a distribution. If it is
   still one reason, the fix did not work.

---

## Resolution

Landed 2026-09-03. Every figure below is labelled **measured** (a run executed
in this worktree, base copy captured at first edit) or **reasoned** (an argument,
not a run). Base is `origin/main` `4a0ed71a39`.

### What changed

`selectR2PreparedOwnerComponents` (`src/codegen/ir-prepared-free-functions.ts`)
now separates the **deciding predicate** — the entry `admissionPredicates.find`
returns, which alone determines admission — from the **naming predicate**, the
entry whose literal is recorded as the withdrawal reason. The deciding `find`
line is unchanged, byte for byte; on the already-refused path only, when the
named reason is `fast-signature-unproven`, entries 1..N are re-scanned for a
predicate that actually describes the refusal.

Rejected alternatives are unchanged from the plan: re-ordering the table
(forbidden by R2-T1's own comment, and it changes which predicates run on the
*admitted* path), per-family reason splitting (grows the closed vocabulary and
still leaves the later reasons unreachable), and a secondary-reason field
(widens `IrR2Withdrawal`, which is R2-T1's contract).

### Admission is unchanged — the load-bearing measurement

**Measured.** File-copy A/B over a 21-entry corpus (13 `website/playground/examples`
`.ts` files, 7 `tests/fixtures` top-level sources, one fast-lane shape battery)
× 4 lanes (`fast`, `plain`, `standalone`, `fast` + `nativeStrings`) = 84
compiles per arm:

| check | result |
| --- | --- |
| prepared free-function name sets (84 lane×entry sets, 151 prepared units) | **identical**, `JSON.stringify` equality |
| per-row `(prepareAttempts, directBodyEmissions, irBodyEmissions)` + prepared flag, 292 rows | **identical** |
| compiled wasm binary sha256, 84 artifacts | **0 mismatches** |
| compile throws / failures, either arm | **0** — no predicate in the second scan threw |
| attached-reason diffs | **6**, all reason-only, all in the fast lanes |

The six attached-reason moves (fast and fast+nativeStrings, same three units):
`objParam` and `retObj` and `asyncInner` from `admission:fast-signature-unproven`
to `admission:param-signature-unstable` / `return-signature-unstable` /
`async-declaration`.

The plan's edge case about throwing predicates is therefore **measured clean on
this corpus**, not swallowed: no `try` was added, and nothing threw.

### Fast-lane withdrawal-reason histogram

**Measured**, recorded withdrawals (`ctx.irR2WithdrawalsByUnitId`, deduped per
unit) over the same corpus, `fast` lane. Read through a temporary dump hook that
was applied identically to both arms and is **not** part of the diff.

| reason | base | after |
| --- | ---: | ---: |
| `admission:fast-signature-unproven` | 11 | **6** |
| `admission:param-signature-unstable` | 0 | **3** |
| `admission:return-signature-unstable` | 0 | **1** |
| `admission:async-declaration` | 0 | **1** |
| `deferred:unsealed-component` | 5 | 5 |
| `not-attempted:late-feature-preparation` | 3 | 3 |
| `fixed-point:callee-outside-component` | 2 | 2 |
| `fixed-point:storage-terminal-unprepared` | 1 | 1 |

One reason became four. The 6 residual `fast-signature-unproven` rows are units
whose fast signature proof is the *sole* objection — that is now what the reason
means, and it is the reason's correct population, not masking.

**Correction to the issue's framing.** The issue's "32/32 fast-lane rows read
`fast-signature-unproven`" came from #5507's own corpus, which is not
reproducible here. On the corpus above the *attached* fast-lane reason count is
**0 in both arms**: playground fast-lane refusals are `(1, 1, 0)` rows, and
`r2WithdrawalDefect` only admits a reason on a compile-twice `(1, 1, 1)` row.
The histogram above is therefore of **recorded** withdrawals, which is the
population the fix acts on; the attached-row view is the 6-row diff in the table
before it. Both are stated because they answer different questions.

### Trap (a) — the `fast-signature-unproven` pin: option **(a)**, re-pointed

`fast-signature-unproven` **stays in `IR_R2_WITHDRAWAL_REASONS`.** It is
reachable, and the search that establishes it was run rather than reasoned.

**Measured.** The old pin no longer qualifies, exactly as the plan predicted:
under the fix, `op(o: { a: number }): number` records
`admission:param-signature-unstable` in the fast lane, so the base pin fails
(observed as a real red run: base test file + fixed compiler → 1 failed).

**Measured.** A 14-shape battery compiled fast and plain. Two shapes keep
`fast-signature-unproven` post-fix, and both are proven sole-fast-proof
objections by the non-fast lane *preparing* them:

| shape | fast lane | plain lane |
| --- | --- | --- |
| `extRef(e: HTMLElement): number` | `(1,1,1)`, `admission:fast-signature-unproven` | `(1,0,1)` **prepared**, no withdrawal |
| `callable(f: (v: number) => number, v: number): number` | `(1,1,1)`, `admission:fast-signature-unproven` | `(1,0,1)` **prepared**, no withdrawal |

The pin is re-pointed to `extRef` — the opaque-host reference carrier the plan
predicted. `callable` was rejected as the pin because it is R2-E1's population
and is already pinned in this suite's `fixed-point:outside-caller-uncertified`
case; using it twice would couple two independent pins.

Shapes measured *admitted in both lanes* (so unusable as a pin): `scalar`,
`strFn`, `len`, `arrParam`, `boolFn`. Measured refused in both lanes at
`(1, 1, 0)` — no reason to assert on: `mixed(a: number, s: string): string`,
`gen`, `objAndFnRef`. This reproduces the plan's four-shape search and extends
it.

### Non-vacuity — delivered by a positive pin, not a reason pin

The plan is right that a reason pin cannot catch an admission regression, and
this PR does not pretend otherwise. Two separate demonstrations, both **measured**:

1. **The reason-flip pins are red on base.** The new test
   `(#5282) a fast-lane refusal names its own predicate, not the fast arm`
   fails against the base compiler (`1 failed | 8 passed`) and passes after
   (`9 passed`).
2. **The #5507 revert now fails.** Replacing the R2-F1
   `r2FastMixedFixedCarrierSignature` disjunct with `false`:
   - base compiler + base suite → **8 passed (8)** — #5507's recorded vacuity,
     reproduced exactly;
   - this PR's compiler + this PR's suite → **1 failed | 8 passed**, failing on
     the new positive pin with `expected [ 1, 1 ] to deeply equal [ 0, 1 ]`.

   The positive pin is `arrParam(v: number[]): number`, asserted to emit
   `(0, 1)` with a `preparedComponentId` and **no** withdrawal. **Measured:**
   dropping the F1 disjunct flips exactly three battery shapes — `arrParam`,
   `strFn(x: string): string`, `len(s: string): number` — from prepared to
   `(1, 1, 1)` withdrawn; every other shape is unchanged.

### Acceptance measurements, against the plan's list

| # | criterion | result |
| --- | --- | --- |
| 1 | admission unchanged | **measured** — 84/84 prepared sets and wasm sha256 identical; `check:ir-only` READY with `scripts/ir-only-baseline.json` unmodified |
| 2 | `objParam` fast records `param-signature-unstable` | **measured** — was `fast-signature-unproven` |
| 3 | fast-lane async records `async-declaration` | **measured** — `asyncInner` |
| 4 | shapes suite green, pin decision stated | **measured** — 9/9; option (a), search recorded above |
| 5 | positive F1 pin exists and the revert turns it red | **measured** — revert run recorded above |
| 6 | histogram before/after | **measured** — one reason → four |

### Footprint

`src/codegen/ir-prepared-free-functions.ts` (+16 LOC, allowance granted in this
file's frontmatter) and `tests/issue-3521-r2-withdrawal-shapes.test.ts`.
`src/codegen/ir-overlay-outcomes.ts` is **not** touched, so #5262 / #5263 /
#5283 stay conflict-free. The fixed-point table and the R3 functions are
untouched.

### Left open, deliberately

- A fast-lane refusal that lands at `(1, 1, 0)` still carries **no** attached
  reason — `r2WithdrawalDefect` only admits one on `(1, 1, 1)`. That is the
  larger share of the playground fast lane and is the plan's out-of-scope note,
  restated here because it bounds what this telemetry can answer today.
- Whether R2-E1 needs a *reference-carrier-specific* reason (splitting
  `fast-signature-unproven` per family) is still open. It is now answerable:
  reference carriers are the reason's remaining population, so the split is a
  refinement rather than a way out of the masking.
