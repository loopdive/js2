---
id: 7436
title: "Prepared: source-closure requirements never settle, so every downstream currentness check re-derives per literal"
status: suspended
sprint: current
created: 2026-11-19
updated: 2026-11-20
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354, 7365, 7397, 7415]
---

# #7436 — settle the source-closure and invocation requirements

## Problem

Measured on S1's full-prelude stand-in program (see Measured). The compile
spends 67 % of its self time in `src/ir/program/data.ts`, mostly the
`preparedIrDataMismatch` walker, `hasNativeCollectionState` and
`immutableCopy`, plus 26 % in GC. The inclusive chain:

1. Every emitted string literal goes `ownerFor` → `checkCompletedOwner` →
   `checkReservationInput` (53 %), which re-plans
   `planNativeStringValuePhysical` (46 %).
2. That re-derives the downstream requirements and deep-compares each against
   its issued snapshot:
   - `assertNativeSourceClosureRequirementsCurrent`: 36 %;
   - `assertNativeInvocationRequirementsCurrent`: 27 %;
   - `assertNativeRealmRequirementsCurrent`: 19 %;
   - `assertNativePromiseSourceCensusCurrent`: 15 %, inside the invocation
     check.

**Root cause.** `planNativeSourceClosureRequirements` issues
`Object.freeze({ ...data, demands })`, which freezes one level over unfrozen
arrays. Probe on this program: `demands` is immutable, `data` is not, and
`{ ...snapshot, demands }` is. Every downstream pack carries the source-closure
requirements, so on a program with closures no settled verdict can ever hold:

- not the realm one (#7397);
- not perf2's reservation-input one;
- not one on the invocation requirements.

The synthetic prelude-shaped program of #7365 has no closure signatures, so
it never showed this. The cost scales with string literals × program size.

## Implementation Plan

- **Module:** `src/ir/program/native-source-closure-requirements.ts` and
  `src/ir/program/native-invocation-requirements.ts` only.
- **Freeze at the issuing site.** `planNativeSourceClosureRequirements` issues
  `Object.freeze({ ...snapshot, demands })` from the frozen snapshot, not from
  the unfrozen `data`.
- **Settle through the existing `PreparedIrSettledChecks`** (#7354 Perf); no
  new mechanism:
  - `assertNativeSourceClosureRequirementsCurrent` runs its current check
    under a module-level `PreparedIrSettledChecks<NativeSourceClosureRequirements>`;
  - `assertNativeInvocationRequirementsCurrent` does the same with
    `PreparedIrSettledChecks<NativeInvocationRequirements>`.
  - Both are fail-closed: a pack that can still change is re-checked at every
    use.
- **Contract:** neutral.
- **Design question from the lead, not yet answered:** should the
  string-literal physical plan be computed once per program instead of per
  literal (`checkReservationInput` → `planNativeStringValuePhysical`)? That
  plan is in perf2's chain (`native-string-values.ts`). Measure both
  variants before choosing.
- **Quality criterion:**
  - the same settle shape as `native-object-access-requirements.ts` and #7397;
  - imports at the top of each file, not inline;
  - no duplicate helper.

## Measured (2026-11-19)

The program is S1's full prelude: branch `claude/7354-fn-standin-research`
23c7f9ec0c, `research/7354-fn-standin/t3.mts` on `test262/harness/assert.js`,
`test262/harness/sta.js` and `test262/test/language/asi/S7.9_A6.1_T2.js`.
Source sha1 c70fb78b. 4-core box, one compile per process.

| tree | compile | peak RSS | output sha1 |
|---|---|---|---|
| base 23c7f9ec | 1,002 s | 1,550 MB | e185e243 |
| base + #7365 B′ + #7397 + #7415 ("stack") | 967 s | 1,540 MB | e185e243 |
| stack + this change (experiment) | 475 s | 1,504 MB | e185e243 |

- **This change halves the compile (−51 %).** It also lets the #7397 and
  perf2 verdicts settle on programs with closures.
- **Not measured yet:** the share left in `data.ts` after the change (needs a
  second CPU profile), and the "plan once per program" variant.

### Reproduction notes

- S1's stand-ins need these environment variables:
  - `CENSUS_STUBS=s0,s1,toprim,tostr-fn,mcall,dyn.json_stringify,dyn.member_get,dyn.object_tag`;
  - `FN_STANDIN_C1=1`.

  Without them the compile is refused in under 1 s.
- `t3.mts` imports `../src`. Copy it to `.tmp/t3.mts` and run it from the
  repo root.
- Copy `fn-standin.mjs` to `scripts/ir-census/`.
- `test262` must be a real checkout, or a symlink to one.
- Profile: `node --cpu-prof --cpu-prof-interval 5000 --import tsx .tmp/t3.mts …`.

## Acceptance criteria

1. Full prelude: base vs fix compile time, output sha1 identical (above).
2. A test file:
   - an issued source-closure pack is deeply immutable and is checked once;
   - a mutable pack is re-checked at every use and refuses a mutation;
   - a shared-prototype change re-checks;
   - the same three for the invocation pack.
3. The realm, request-literal, source-closure, invocation and #7354 Perf test
   files: no new failures against `claude/7354-o`.
4. Gates: loc, func, coercion, oracle, dead-exports, import-cycles,
   compiler-boundaries inventory.

## Suspended Work (2026-11-20, budget window closed)

- **Branch:** `claude/7436-source-closure-settle`, based on `claude/7354-o`
  e587829733. There is no PR.
- **Head:** the experiment code, committed as WIP. It is prototype quality:
  the `PreparedIrSettledChecks` import sits mid-file and the settle constant
  sits after the function. Clean both up to the plan above before any PR.
- **Next steps:**
  1. Clean the code to the plan.
  2. Write the test file.
  3. Run the related test files against `claude/7354-o`, and the gates.
  4. Re-measure the full prelude and take a CPU profile for the share left in
     `data.ts`.
  5. Measure the "plan once per program" variant (perf2's chain; coordinate
     with perf2's owner first).
  6. Open the PR with hold, stacked as needed, and say so in the body.
- **Open review threads:** none.
