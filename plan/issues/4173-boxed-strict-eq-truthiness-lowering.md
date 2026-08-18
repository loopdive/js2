---
id: 4173
title: "perf: boxed strict-eq / truthiness helpers are 7.1% of the standalone acorn parse — `__extern_strict_eq` 3.7% + `__is_truthy` 3.1% self-time, and no issue owned this bucket"
status: done
completed: 2026-08-06
assignee: ttraenkler/claude-fable-4
sprint: 78
created: 2026-08-06
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
goal: performance
related: [4157, 4155, 743, 3926]
origin: "2026-08-06 post-campaign CPU profile (#4157, PR #4143) — one of two measured buckets with no owning issue"
loc-budget-allow:
  - src/codegen/any-helpers.ts
  - src/codegen/context/types.ts
  - src/codegen/registry/imports.ts
  - src/compiler.ts
func-budget-allow:
  - src/codegen/registry/imports.ts::addUnionImportsAsNativeFuncs
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #4173 — boxed strict-eq / truthiness lowering

## Problem (measured, not estimated)

The 2026-08-06 post-campaign profile of the standalone acorn parse (39,586
samples over 48.4 s, 144.2 ms/op; full table in the umbrella
`plan/issues/4157-close-the-acorn-node-performance-gap.md`) attributes
**7.1% of total self-time** to the dynamic-equality bucket:

- `__extern_strict_eq` — 3.7%
- `__is_truthy` — 3.1%

**Top payer: `parseSubscript`'s `===` chain.** acorn compares tokens and node
types constantly (`this.type === tt.name`, `node.type === "Identifier"`), and
every comparison whose operands are boxed goes through the generic helper.

No issue owned this bucket before this one — it is one of the two costs the
profile surfaced that the whole #4157 program had no line item for.

## Direction (verify against source before implementing)

Two independent angles, both cheaper than typing the values (which is #743's
long game):

1. **Lower the comparison, not the operands.** A `===` whose two sides are
   both known-boxed can dispatch on cheap identity first (same ref → true)
   and on unboxed tag pairs (`ref.test` both sides for the same variant →
   compare payloads directly) before falling back to the generic helper.
   The helper itself may also be a ladder that can hash/br_table like
   #3926's `__extern_get`.
2. **Truthiness at branch sites.** `__is_truthy` calls at `if`/`&&`/`!` sites
   whose operand is a boxed value with a statically-known variant subset can
   inline the two-or-three-instruction test instead of the call. Measure how
   many of the 3.1% sites have single-variant operands before building.

## Acceptance criteria

- [x] The dynamic-eq bucket's self-time drops from 7.1% on the profile
      driver (`scripts/profile-buckets.mjs`, landed with PR #4143), or the
      issue records measured evidence for why it cannot. (Bucket −27%
      absolute; `__extern_strict_eq` self −50% absolute. The `__is_truthy`
      half is measured-irreducible in-helper — evidence in Results.)
- [x] `standaloneDynamic` A/B (3 back-to-back pairs) reported with std —
      per the #4157 measurement rules; a wash gets recorded, not stretched.
      (6 pairs run, 2 contamination-flagged by ratioStd; clean pairs mean
      +7.1%.)
- [x] No behavioral change: `===`/`!==`/truthiness semantics pinned by the
      equivalence suites (loose-equality, strict-equality-edge-cases,
      logical-operators files) before and after. (Plus a dual-regime
      standalone battery in `tests/issue-4173-fast-strict-eq.test.ts`.)

## Dupe check

#3926 is the same *shape* of fix (ladder → hashed dispatch) applied to a
different helper; no overlap in code. #743 would remove the need by unboxing
the values — long-horizon, not a reason to leave 7.1% on the table now.

## Results (2026-08-06, ttraenkler/claude-fable-4 — branch `claude/issue-4173-boxed-strict-eq`)

### Step-1 profile breakdown (measured BEFORE coding; 4-core container, 300 iters)

This box ran hotter than the campaign box (GC 28.8% vs 18.5%), so shares
differ from the issue header; absolute seconds below are the honest unit.
Baseline (`bcf4a75c7`): 71.3 s wall, 55,667 samples.

- `__extern_strict_eq` **3.06%** self (2.18 s). Callers: `parseSubscript`
  1.05, `parseMaybeConditional` 0.24, `__dc_Parser_eat_1_g` 0.24,
  `__call_m_indexOf_1` 0.22, `parseMaybeUnary` 0.21, `parseSubscripts` 0.17,
  `isContextual` 0.16, … — spread wide, in-helper fix required.
- `__is_truthy` **2.77%** self (1.98 s). Callers: `__dc_Parser_nextToken_0_g`
  0.40, `pp.next` 0.28, `parseMaybeUnary`/`parseSubscript`/`finishNodeAt`
  0.17 each, `__fnctor_Node_new` 0.15, … — also spread wide; operands are a
  mix of undefined singletons, boxed booleans (`options.locations` etc.) and
  plain objects (`curContext` style guards).

### Root cause — WHY the eq helper was expensive

`__extern_strict_eq`'s identity `ref.eq` fast path (#2734) only decides the
MATCH case. acorn's `this.type === tt.x` chains MISS most of the time (token
mismatch is the common case), and the miss fell through to
`__any_from_extern(a)` + `__any_from_extern(b)` + `__any_strict_eq` — each
`__any_from_extern` call **allocates a fresh 5-field `$AnyValue` struct**, so
every failed token comparison cost 3 calls, two classifier ladders, and two
GC allocations just to conclude "different objects → false". The allocation
stream also fed the GC bucket (the profile's #1 line).

### Fix — fast tag-pair dispatch on the identity-miss path

New `src/codegen/extern-eq-fast.ts` (`buildFastStrictEqDispatch`), spliced
into `ensureExternStrictEqHelper` (any-helpers.ts) inside the both-eq-refs
branch after the identity check. When NEITHER internalized operand is an
`$AnyValue` box, §7.2.16 IsStrictlyEqual is decided locally, call- and
alloc-free:

- number × number (BoxedNumber/i31, either mix) → `f64.eq` — NaN≠NaN and
  +0===-0 fall out of `f64.eq` itself;
- string × string (`$AnyString` incl. cons/hashed) → `__str_equals` (VALUE
  equality; self-flattening, hash fast-reject);
- bool × bool → normalized payload equality; bigint × bigint → `i64.eq`;
- every remaining pairing → **false** (identity already failed; strict
  equality across distinct value classes is always false — same answers the
  default-ON tag-5 classifier (#2040/#2585) produced through the slow path).

`$AnyValue` on EITHER side keeps the full legacy path — a tag-5/tag-6 box
can wrap the SAME reference the other operand holds raw, and only
`__any_strict_eq`'s #2175 cross-representation reconciliation may decide
those. If a module has a native string type but no `__str_equals`, the whole
fast path is skipped (a string pair would otherwise fast-false wrongly).

`__is_truthy` (registry/imports.ts): the body internalized the operand
TWICE (`any.convert_extern` once for the `$AnyValue` arm, once for the
ladder); now converts once under the flag. The rest of the ladder is already
minimal (one ref.test per falsy-capable type; plain objects must fail all of
them — no cheaper positive test exists without a shared box supertype), and
the caller profile shows operands spread across undefined/bool/object with
no dominant provable-variant site, so direction 2's site-level inlining was
measured-out, not built.

Flag: `fastStrictEq` CompileOption / `JS2WASM_FAST_STRICT_EQ` env,
**default ON**; `=0` restores the legacy bodies byte-for-byte.

### Measured — profile (same driver, 300 iters, back-to-back)

| metric | base | patched | note |
| --- | --- | --- | --- |
| `__extern_strict_eq` self | 3.06% (2.18 s) | 1.99% (1.10 s) | **−50% absolute** |
| `__is_truthy` self | 2.77% (1.98 s) | 3.41% (1.89 s) | −5% absolute (share up: total shrank) |
| `__str_equals` self | <top-25 | 1.06% (0.59 s) | string arm now attributed directly |
| `__any_from_extern` self | 0.73% | <top-25 | alloc path off the hot loop |
| dynamic-eq bucket | 6.10% (4.35 s) | 5.71% (3.16 s) | **−27% absolute** |
| gc-engine | 28.8% (20.5 s) | 17.8% (9.9 s) | part ambient (base ran GC-hot vs the campaign 18.5%); part the removed 2-allocs-per-miss stream |
| total wall (300 parses) | 71.3 s | 55.3 s | includes ambient drift — the A/B below is the quotable number |

### Measured — `benchmark:acorn:standalone-dynamic` A/B (env-flag flip, same checkout, interleaved)

ratio = node/wasm (higher better). Contaminated runs are called out by the
lane's own `ratioStd` (>0.02 ⇒ box load spike, both lanes inflated):

| pair | base ratio (std) | new ratio (std) | Δ ratio | base wasm ms | new wasm ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.11727 (.016) | 0.12250 (.013) | +4.5% | 173.6 | 155.8 |
| 2 | 0.11450 (.010) | 0.12215 (.005) | +6.7% | 181.7 | 176.4 |
| 3 | 0.10381 (.056) ⚠ | 0.12825 (.009) | (base contaminated) | 351.3 ⚠ | 160.9 |
| 4 | 0.11745 (.012) | 0.11612 (.008) | −1.1% | 183.9 | 168.1 |
| 5 | 0.11697 (.015) | 0.09868 (.032) ⚠ | (new contaminated) | 181.1 | 215.4 ⚠ |
| 6 | 0.10703 (.015) | 0.12658 (.016) | +18.3% | 185.7 | 163.8 |

Fully-clean pairs (1/2/4/6): **+4.5 / +6.7 / −1.1 / +18.3 → mean +7.1%**.
Pooled clean runs: base mean ratio 0.11464 (σ .0040, n=5) vs new 0.12312
(σ .0042, n=5) → **+7.4% relative throughput**; wasm-side medians 181.2 →
165.0 ms/op (**−8.9%**), new faster in every clean pair. Weaker separation
than #3926's non-overlap (pair 4 washed on a node-side dip), but 3-of-4
clean pairs positive plus the −50% helper self-time make the direction
unambiguous.

**Binary size**: bench artifact 1,477,769 → 1,477,991 B (**+222 B, +0.015%**).

**Ship decision: default ON.** Clean A/B win, suites green (below),
standalone-only emit (host lane byte-identical), trivial size cost;
`JS2WASM_FAST_STRICT_EQ=0` is the rollback lever.

### Gates / canaries

- tsc, lint, oracle-ratchet, loc-budget, func-budget (with the frontmatter
  grants above — plumbing-only overages, +2…+10 lines), dead-exports,
  coercion-sites, stack-balance, prettier: all exit 0.
- Suites green: `tests/equivalence/{strict-equality-edge-cases,
  equality-mixed-types, loose-equality, logical-operators, typeof-comparison,
  boolean-relational-comparison}` (38 tests), `issue-4155-*` Phase 0 (19),
  `issue-2660-*` fnctor suites (54), new `tests/issue-4173-fast-strict-eq.test.ts`
  (both flag regimes, 39-assert battery incl. NaN/±0/rope-string/indexOf).
- acorn dogfood canaries **2, 3, 4, 5**, `functionImports: []`, exactly the
  **3 pre-existing IR-FALLBACKs** (re-verified after the extraction refactor).

### Observed pre-existing edge (NOT changed here)

`x === x` where x is a tag-3 `$AnyValue` NaN box returns 1 via the #2734
identity path (the #3174 carve-out only exempts `$BoxedNumber` carriers, not
`$AnyValue` tag-3). Identical under both flag regimes — the identity check
runs before the new dispatch — but a spec gap if any-lane NaN carriers ever
reach `__extern_strict_eq` self-compared. Candidate follow-up.
