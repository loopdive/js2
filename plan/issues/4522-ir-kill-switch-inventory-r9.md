---
id: 4522
title: "Inventory and retirement plan for IR/direct env kill-switches"
status: in-progress
sprint: current
created: 2026-08-16
updated: 2026-08-30
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: hardening
area: ir, tooling
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3518
related: [3518, 3792]
origin: "tech-lead IR design review 2026-08-16"
---

# #4522 — kill-switch inventory for the R9 flip

## Problem

R9 of #3518 requires all IR/legacy escape hatches and compile-twice switches
removed "from public options, env handling, tests, scripts, and
documentation". Measured 2026-08-16: **13 distinct `JS2WASM_IR_*` env vars**
(~57 references) exist under `src/`:

`JS2WASM_IR_INLINE` (15) · `JS2WASM_IR_FIRST` (10) · `JS2WASM_IR_SHAPE_DIAG`
(7) · `JS2WASM_IR_I…` (4) · `JS2WASM_IR_POSTCLAIM_LOG` (3) ·
`JS2WASM_IR_OWNERSHIP` (3) · `JS2WASM_IR_OBJECT_SHAPES` (3) ·
`JS2WASM_IR_GVN` (3) · `JS2WASM_IR_ESCAPE` (3) · `JS2WASM_IR_ASYNC` (3) ·
`JS2WASM_IR_VERIFY_DOMINANCE_NAIVE` (2) · `JS2WASM_IR_STRING_BUILDER` (2) ·
`JS2WASM_IR_GVN_DEBUG` (1)

These are not one category, and R9 must not delete them uniformly:
diagnostics (`*_DIAG`, `*_LOG`, `*_DEBUG`) and self-checks
(`VERIFY_DOMINANCE_NAIVE` cross-checks the fast dominance algorithm against
the naive one) are healthy and should SURVIVE; feature kill-switches
(`IR_FIRST`, `IR_STRING_BUILDER`, pass toggles) are the R9 debt. Nobody owns
the classification today, and rediscovering it at flip time is exactly the
kind of last-minute audit R9 should not depend on.

## Acceptance criteria

- [x] A table in this issue (or `plan/log/ir-adoption.md`) classifying every
      `JS2WASM_IR_*` var: keep-as-diagnostic / keep-as-self-check /
      retire-at-R9 (with the retiring issue or R-slice named) /
      retire-now-already-dead.
- [x] Any var classified retire-now is actually removed in the same PR, with
      grep-zero evidence. *(Vacuous: no var classified retire-now — every
      reader is live; see the table.)*
- [x] A one-line guard is added to the R9 acceptance checklist in #3518
      pointing at this inventory, so the flip consumes it rather than
      re-auditing.
- [x] Later bounded multi-source route switches are appended here when they
      land; a `JS2WASM_MULTI_PREPARED_*_CUTOVER` reader is R9 debt even though
      it is outside the historical `JS2WASM_IR_*` prefix census.

## The inventory (measured 2026-08-21)

**15 vars now, not 14** — the current source census includes the earlier
`JS2WASM_IR_CUTOVER_AUDIT` addition and the live exact mixed-primitive
conditional reader omitted by the prior table; the truncated `JS2WASM_IR_I…`
in the problem statement is `JS2WASM_IR_I32_DOMAIN`. The classification key: a
var is **R9 debt exactly when flipping it selects the legacy/direct path or a
legacy representation** ("IR/legacy escape hatches and compile-twice switches",
#3518 R9). A toggle over an IR-internal pass, experiment, or log never
resurrects the direct front-end and survives the flip — the problem statement's
blanket "pass toggles are the R9 debt" is corrected accordingly, per-var below.

| Var | Default | What flipping does | Classification | Retired by |
| --- | --- | --- | --- | --- |
| `JS2WASM_IR_FIRST` | on | `=0` disables IR-first legacy-body skipping — forces compile-twice | **retire-at-R9** (named in the R9 row of #3518 itself) | R9 |
| `JS2WASM_IR_STRING_BUILDER` | on | `=0` forces builder loops to legacy (`string-builder-candidate`) | **retire-at-R9** — legacy escape hatch; its always-deferred sibling arm (`containsCountedLiteralStringAppend`, the #1004 repeat-fold) is a selector gap #3518's coverage closure must own, not an env var | R9 |
| `JS2WASM_IR_ASYNC` | on | `=0` clears `supportsAsyncIr` — async bodies route to legacy | **retire-at-R9** | R7 (#3527/#1373b) then R9 |
| `JS2WASM_IR_MIXED_PRIMITIVE_CONDITIONAL` | on | `=0` rejects the exact mixed primitive conditional/wrapper route before claim, leaving the function direct-owned | **retire-at-R9** — separately owned exact selector rollback | #5092 then R9 |
| `JS2WASM_IR_OBJECT_SHAPES` | on | `=0` reverts to the legacy boxed-externref object representation | **retire-at-R9** — legacy-representation escape hatch | R9 |
| `JS2WASM_MULTI_PREPARED_SCALAR_LEAF_CUTOVER` | on | `=0` restores direct-first ownership for the bounded scalar leaf | **retire-at-R9** — bounded direct-route escape hatch | #3518 R9 |
| `JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER` | on | `=0` restores direct-first ownership for the bounded array leaf | **retire-at-R9** — bounded direct-route escape hatch | #3518 R9 |
| `JS2WASM_MULTI_PREPARED_STRING_CUTOVER` | on | `=0` restores direct-first ownership for the exact counted-string benchmark leaf while retaining its late IR overlay | **retire-at-R9** — bounded direct-route escape hatch | #3518 R9 |
| `JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER` | on | `=0` restores direct-first ownership for the bounded benchmark loop leaf | **retire-at-R9** — bounded direct-route escape hatch | #3518 R9 |
| `JS2WASM_MULTI_PREPARED_FIB_PAIR_CUTOVER` | on | `=0` restores direct-first ownership for the bounded Fibonacci pair | **retire-at-R9** — bounded direct-route escape hatch | #3518 R9 |
| `JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER` | on | `=0`/`false` prevents eligible standalone multi-source callable components from becoming Prepared, leaving their direct-body route available | **retire-at-R9** — bounded direct-route escape hatch | #3518 R9 |
| `JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER` | off | `=1` enables the exact multi-source Prepared module-init route; unset retains the direct module-init owner | **retire-at-R9** — bounded pre-default direct-route gate | #3518 R9 |
| `JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER` | on | `=0` restores the legacy standalone class-body correlation route | **retire-at-R9** — bounded direct-route escape hatch | #3518 R9 |
| `JS2WASM_PREPARED_TIMER_SHIM_CUTOVER` | on | `=0`/`false` restores the direct injected timer-shim body route | **retire-at-R9** — bounded direct-route escape hatch | #3518 R9 |
| `JS2WASM_LINEAR_IR` | on | `=0` restores byte-identical direct-backend ownership for linear IR candidates | **retire-at-R9** — default-on direct-backend escape hatch | #3528 then R9 |
| `JS2WASM_IR_INLINE` | on | `=0`/tuned sets control the IR-level inliner (#4157) | keep-as-tuning — IR pass config, no legacy involvement (a `-O`-style knob) | — |
| `JS2WASM_IR_GVN` | off | `1` enables the GVN pass; `poison` runs the liveness self-check | keep-as-experiment + self-check — IR pass, no legacy; its owner decides the default flip | — |
| `JS2WASM_IR_GVN_DEBUG` | off | debug prints for GVN | keep-as-diagnostic | — |
| `JS2WASM_IR_I32_DOMAIN` | off | `=1` opts in to the experimental i32 domain propagation | keep-as-experiment — pre-default gate on IR-internal analysis, no legacy | — |
| `JS2WASM_IR_OWNERSHIP` | off | `=1` runs the gated annotation-only ownership analysis | keep-as-diagnostic/experiment | — |
| `JS2WASM_IR_ESCAPE` | off | `=1` runs the gated annotation-only escape classification | keep-as-diagnostic/experiment | — |
| `JS2WASM_IR_SHAPE_DIAG` | off | `=1` records per-shape rejection attribution | keep-as-diagnostic | — |
| `JS2WASM_IR_POSTCLAIM_LOG` | off | `=<path>` appends post-claim JSONL records | keep-as-diagnostic | — |
| `JS2WASM_IR_CUTOVER_AUDIT` | off | `=<path>` appends cutover-invocation audit records | keep-as-diagnostic — explicitly serves the R9/R10 audits | — |
| `JS2WASM_IR_VERIFY_DOMINANCE_NAIVE` | off | `=1` cross-checks fast dominance against the naive algorithm | keep-as-self-check | — |

Nothing is retire-now-already-dead: every var has a live reader under `src/`
(verified by the per-var grep above the table's compilation, 2026-08-21).

The original four global `JS2WASM_IR_*` retire-at-R9 vars remain
`JS2WASM_IR_FIRST`, `JS2WASM_IR_STRING_BUILDER`, `JS2WASM_IR_ASYNC`, and
`JS2WASM_IR_OBJECT_SHAPES`; the exact mixed-primitive conditional rollback is a
fifth selector-route row, separately owned by #5092. The complete 2026-08-30
source census finds fifteen `JS2WASM_IR_*` readers and nine non-test named
Prepared cutover readers: the five earlier multi-source leaves plus callable
component, module-init, standalone class, and timer-shim routes, plus the
default-on `JS2WASM_LINEAR_IR` direct-backend reader. These fifteen
route/representation readers are the complete current `retire-at-R9` env
denominator. `JS2WASM_LINEAR_IR_COVERAGE` and `JS2WASM_LINEAR_IR_DEBUG` are
opt-in observation/debug siblings, while `JS2WASM_DIRECT_CALLS` only tunes
direct-codegen devirtualization and `JS2WASM_ASYNC_CLOSURE_PROMISE` only selects
a host async-wrapper ABI; none of those select a source unit between IR and a
direct body. R9 consumes the complete live table, not a stale historical
cardinality. Every new bounded route switch must update this table in the same
landing PR.

## 2026-08-30 Sol implementation plan — retire the exact Math rollback family

### Grounded scope

Ground this slice on `origin/main` at
`01fb67624e2f645b7e92dd9f8e47478e3face9ba`. Current production contains
exactly 21 per-intrinsic Math rollback readers, contiguous in
`src/ir/select.ts`'s Math-plan gate. Every one is default-on and withdraws only
when its environment value is exactly `"0"`. The family covers inverse trig,
derived logarithms, hyperbolic and inverse-hyperbolic functions, cube root,
single-precision rounding, leading-zero count, integer multiply, min/max,
round, sign, and exponential-minus-one.

This is a bounded R9 debt-removal checkpoint, not the R9 policy flip. The live
mixed-primitive conditional rollback is separately owned by #5092 and the
parallel semantic-selector work; global IR-first, string-builder, async,
object-shape, and multi-prepared cutover switches remain. Do not edit those
readers or claim that the complete inventory is retired.

### Exact change contract

1. Remove all 21 Math-specific environment branches from the selector. Keep
   the target-capability decision and the exact ambient-binding/source-shape
   recognizer unchanged; removal makes an already-default claim unconditional,
   it does not admit a new syntax shape.
2. Update the 14 focused Math test files. Delete only the narrow environment-
   withdrawal controls and their save/restore plumbing. Preserve every exact
   positive route, direct-body poison, IR outcome/WAT/provider assertion, and
   shadowed, aliased, reassigned, optional, wrong-arity, or otherwise non-
   ambient near miss.
3. Where a narrow rollback was the only A/B oracle, replace it with the public
   global `experimentalIR: false` control for the same exact source and lane.
   The default build must remain IR-owned with `legacyBodyEmitted: false`; the
   direct control must preserve runtime value, exports/imports, and Wasm
   validity. The global oracle is retained only for comparison and is not
   retired by this slice.
4. Update this inventory, the R9 record in
   `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`, and the
   14 originating Math issue records append-only. Historical statements may
   say “the per-intrinsic rollback used during initial rollout”; the retired
   environment identifiers themselves must disappear from active plans and
   documentation.
5. Repository grep for the Math rollback prefix must be exactly zero across
   source, tests, scripts, and plans. The broader IR environment inventory must
   still enumerate the separately owned mixed-primitive rollback and all other
   surviving R9 debt; an empty or stale inventory is a failure.

### Mutation and acceptance matrix

- Map all 21 intrinsics one-to-one to the existing 14 focused suites; no
  intrinsic may disappear behind a family-level representative. The closed
  inventory is `atan`, `tan`, `asin`, `acos`, `log10`, `log1p`, `sinh`,
  `cosh`, `tanh`, `cbrt`, `expm1`, `clz32`, `imul`, `min`, `max`, `asinh`,
  `acosh`, `atanh`, `sign`, `round`, and `fround`.
- Add `tests/issue-3518-ir-math-switch-retirement.test.ts` with a literal,
  checked 21-row method/arity/provider table. Its positive matrix is exactly
  42 cells: every method in host and standalone must be `emitted`, use an
  IR-only body, and have no legacy body. The table and the production Math
  intrinsic registry must join one-to-one; missing, duplicate, and foreign
  rows fail closed.
- Run 21 shadowed-`Math` cells and 21 extracted/aliased-method cells. Every one
  remains pre-claim `unsupported`, absent from `irCompiledFuncs`, with no
  post-claim error or invariant and body flags `legacy=true`, `IR=false` under
  the current hybrid policy.
- Run 42 wrong-arity cells: one argument too few and one too many for every
  method. Apply the same exact pre-claim/no-prefix/body assertions.
- Run 21 provider mutations: wrong intrinsic binding for each of the sixteen
  callable-backed methods, one malformed `fround` sequence, and four
  wrong/unknown composite operations for `clz32`, `imul`, `min`, and `max`,
  including crossed `min`/`max`. Provider mutation evidence must be exact and
  may not be replaced by a representative family row.
- Retain every stronger originating-suite negative: reassigned bindings,
  computed or optional access/call, spread, unsupported operands, poison/WAT,
  and special numeric values (`NaN`, infinities, signed zero, and 32-bit
  coercion edges) where applicable. `max` must gain its own shadow, alias, and
  wrong-arity evidence if the shared retirement matrix is the first place it
  becomes non-vacuous.
- Run at least one exact global-direct A/B control per originating suite and
  assert the same runtime result and public artifact surface. The direct arm is
  an observational oracle only; it must not become a production fallback.
- Prove census non-vacuity without an ad-hoc script: the grounded pre-removal
  record is exactly 21 production readers, and the candidate repository grep
  is exactly zero. The new table must reject a missing, duplicate, or synthetic
  foreign legacy entry so a zero caused by an empty/disabled census cannot
  pass.

### Four-arm A/B contract

1. On the grounded current-main bytes, run the fourteen focused suites and
   three shared #3526 Math suites with all 21 names unset.
2. On those same current-main bytes, preserve the existing 21 independent
   withdrawal records: setting exactly one name to `"0"` withdraws only its
   named method while the sibling denominator remains emitted.
3. On candidate bytes with all former names unset, require the same canonical
   source/outcome/import/manifest/runtime projection as arm 1.
4. On candidate bytes with all former names externally set to `"0"`, require
   byte/projection identity with arm 3 and run the complete positive, semantic
   negative, arity, and provider matrices. This is the authoritative proof
   that no hidden reader survived.

### Files and parallel-work lock

Production ownership is limited to `src/ir/select.ts`. Test and record
ownership is limited to the 14 `tests/issue-5101*` through
`tests/issue-5135*` Math files, the new closed-matrix
`tests/issue-3518-ir-math-switch-retirement.test.ts`, their 14 matching issue
records, this inventory, and the #3518 R9 record. The open nested-vec work also
edits `select.ts`, but at a distant hunk; merge current main normally before
publication and re-run a fresh exact-SHA review. Do not touch ProgramABI,
prepared publication, multi-source callable ownership, module-init, or
export-provenance files.

### Validation and landing

Run all 14 focused suites, the new retirement matrix, and
`tests/issue-3526-ir-math-intrinsic-integration.test.ts`,
`tests/issue-3526-ir-runtime-manifest.test.ts`, and
`tests/issue-3526-ir-linear-math-intrinsics.test.ts` together; report
files/tests passed over total and preserve the shared 33-method denominator
and exact 10/33 linear legality boundary. Then run TS7 and TS5 typechecks,
targeted lint/Prettier/diff-check, IR layering, IR fallback/IR-only policy
gates, and the relevant host/standalone equivalence controls. Every heavy
command requires a finite, non-negative one-minute load strictly below logical
cores minus two and an archive-backed `TMPDIR`.
Immediately before committing, run both LOC and function-growth ratchets.
Commit and push through the complete hooks with no bypass. Terra implements;
a fresh independent Sol reviewer must approve the exact pushed SHA before the
regular pull request is marked ready or enqueued. No admin or direct merge is
permitted.

### Candidate implementation record (2026-08-30)

The candidate removes the exact 21 default-on per-method readers from the
shared Math selector while leaving its ambient-binding recognizer and
target-capability condition intact. It removes only the matching withdrawal and
save/restore test plumbing from the fourteen originating suites. The 33-method
production registry and the shared 10/33 linear legality denominator remain
unchanged.

`tests/issue-3518-ir-math-switch-retirement.test.ts` is the closed proof: a
literal 21-row table independently projects the retired subset from the
production registry, rejects missing/duplicate/foreign rows, and runs the
host/standalone, shadow, alias, wrong-arity, and deep provider-mutation cells.
Its global-direct comparison compiles the same combined source with
`experimentalIR: false`, preserving signed-zero and NaN observations through
`Object.is` while comparing runtime and public Wasm surface. Candidate source,
tests, scripts, and plans have a zero census for the retired Math family.

This checkpoint does not retire the mixed-primitive rollback or any global,
string-builder, async, object-shape, or multi-prepared R9 switch. Those remain
live inventory entries until their separately owned policy work lands.
