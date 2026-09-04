---
id: 5313
title: "Two unconditional whole-file `with`-statement walks in object-shape-widening.ts cost 7,838 traversals (40 % of the harness compile-budget drift) on sources containing no `with`"
status: done
completed: 2026-09-04
sprint: current
created: 2026-09-04
updated: 2026-09-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen
goal: ir-full-coverage
related: [5306, 3437, 3433, 3374]
requested_by: ttraenkler/opus-5306
# 2026-09-04 (#5313): +8 lines in the god-file — one import, one early-return
# gate, one call-site gate, and the four comment lines carrying the soundness
# argument for each skip (why a `with`-free source provably marks nothing).
# Both budgets sit at ZERO headroom, so any gate at all needs a grant. The
# change REFUNDS 7,838 traversals of the #3437 harness compile-work budget —
# a net reduction in compiler work bought for 8 lines of guard.
loc-budget-allow:
  - src/codegen/declarations/object-shape-widening.ts
func-budget-allow:
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
---

# Two full-source walks look for `with` on every compile, `with` or not

Bisecting the #3437 harness compile-work budget for
[#5306](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5306-harness-compile-budget-ceiling-margin-exhausted)
pinned 40 % of the 2026-08-20 → 2026-09-04 drift to a single merge:

| | |
| --- | --- |
| commit | `52b61990fe` (2026-08-26) |
| PR | #4922 `fix(es5): combine standalone conformance gains` |
| measured | 131,169 → **139,007** (+7,838) |
| share of total drift | **39.9 %** of +19,641 |

Per-caller attribution (patch the `forEachChildMeter` in `src/ts-api.ts` to
record caller frames; method in #5306's PR) puts **all** of it in one file:

```
+7838   15661 -> 23499  src/codegen/declarations/object-shape-widening.ts
```

and exactly two new whole-source-file walks, each one full pass over the
3,919-node fixture:

1. `markRealmGlobalWithTargets` — an inner arrow inside
   `collectGrowableObjectLiterals`. It recurses the entire source file, and its
   only payload is `if (ts.isWithStatement(node)) { … }`.
2. `visit` inside the new `collectRedeclaredWithTargetObjects`. It collects
   variable declarations *and* `with` targets, and only ever produces a result
   for symbols that are **both** redeclared and a `with` target
   (`if (declarations.length < 2 || !withTargetSymbols.has(symbol)) continue;`).

Both run unconditionally. The #3437 fixture contains no `with` statement, so
both walks are pure cost on it — and `with` is rare in real input too, so this
is pure cost on almost every compile, not just the fixture.

## Why this is worth fixing rather than banking

This is not the #3433 quadratic class (the walks are O(file), not
O(call-sites × file)), so it will not blow up CI. It is worth fixing because it
is ~7.8 k traversals of budget bought for a feature that fires on a construct
almost no source uses, and because the guard already exists as a pattern:
`src/codegen/source-scan-predicates.ts` has short-circuiting predicates of
exactly this shape (`sourceContainsClass`, `sourceContainsBindingPattern`).

For contrast, the other two commits in the same bisection were assessed and
deliberately **not** filed: PR #5204's `prepareIdentityPreservingStructuralParams`
and `mixedAssignmentFacts` are memoized single passes for genuinely new
analysis, and PR #5336's `sourceNodeWeight` is a `WeakMap`-cached node count.
They cost real budget but buy something on every source. These two buy nothing
unless the source says `with`.

## Acceptance criteria

1. Both walks are gated on a **memoized** "does this source contain a `with`
   statement" predicate, living with the other predicates in
   `src/codegen/source-scan-predicates.ts` (memoized per `ts.SourceFile`, so a
   second consumer is free). A cheap pre-filter on `sourceFile.text` before the
   AST walk is acceptable as long as the AST walk remains the authority.
2. `pnpm run check:harness-compile-budget` measures a drop of about 7,838
   traversals from the #5306 budget of 150,774; bank it with `--update` in the
   same PR (a decrease is the sanctioned write).
3. No `with`-related behaviour changes: the equivalence suite and the
   `with`-covering test262 buckets are unchanged. `with` sources must still get
   both scans — the gate is a skip, not a semantic narrowing.

## Non-goals

- Reworking `collectGrowableObjectLiterals` or the redeclaration analysis
  itself. This is a guard, not a redesign.
- Touching PR #5204's or #5336's passes (see above — measured, accepted).

## Landed

### Result

`pnpm run check:harness-compile-budget`, measured on this branch against the
same fixture (`fixtureCallSites=120`) #5306 rebanked from:

| | before | after | delta |
| --- | ---: | ---: | ---: |
| measured traversals | 150,774 | **142,936** | **−7,838** (−5.20 %) |
| banked budget | 150,774 | 142,936 | rebanked with `--update` |
| ceiling (+15 %) | 173,391 | 164,377 | |
| margin left | 22,617 (13.04 %) | 21,441 (13.04 %) | |

−7,838 is the issue's predicted figure to the traversal, and it lands the file
back on its exact pre-#4922 number.

### Attribution

Reproduced #5306's method — the `forEachChildMeter` in `src/ts-api.ts`
temporarily patched to record the caller frame (file:line) of every
shared-`forEachChild` invocation, run over the #3437 fixture, then reverted.
One full pass over the fixture is 3,919 traversals.

Per file:

| file | before | after | delta |
| ---- | -----: | ----: | ----: |
| `src/codegen/declarations/object-shape-widening.ts` | 23,499 | **15,661** | **−7,838** |
| `src/codegen/source-scan-predicates.ts` | 11,804 | 11,804 | **+0** |
| everything else | 115,471 | 115,471 | +0 |

Per call site inside `object-shape-widening.ts`:

| call site | before | after |
| --------- | -----: | ----: |
| `markRealmGlobalWithTargets` (in `collectGrowableObjectLiterals`) | 3,919 | **0** |
| `visit` in `collectRedeclaredWithTargetObjects` | 3,919 | **0** |
| `visit` in `collectRedeclaredObjectIdentityLiterals` | 3,919 | 3,919 |
| `visit` in `collectRepeatedOrdinaryToPrimitiveObjects` | 3,918 | 3,918 |
| the two `scanNestedFunctionExpressions` / `scanStatements` pairs | 7,814 | 7,814 |
| `sourceContainsWithStatement` (new) | — | **0** |

The new predicate costing **0** is the whole design, not a rounding artefact.
A NEGATIVE answer to "does this source contain a `with`" is only knowable after
visiting every node — the walk cannot short-circuit the way `sourceContainsClass`
does. Gating two full passes on an unconditional AST walk would therefore have
refunded 3,919, not 7,838. The `sourceFile.text.includes("with")` pre-filter is
what makes it the full amount, and it is sound in the one direction it is used:
a `with` statement's source text necessarily contains the keyword, and a
reserved word may not be spelled with a unicode escape, so absence of the
substring is definite absence of the statement. It can never answer "yes" —
`withDefaults()`, `{ writable: … }` and the word in a comment all match the
substring, and there the AST walk remains the authority. The same idiom is
already load-bearing in `collectGlobalObjectPropertyNames` (`this`/`globalThis`)
and `collectHeterogeneouslyAssignedModuleVarNames` (which pre-filters on the
identical `"with"` substring).

### Why the skip is sound

Neither walk can mark anything on a `with`-free source, so the gate is a pure
skip and not a narrowing:

- `markRealmGlobalWithTargets` — every effect it has is inside its
  `if (ts.isWithStatement(node))` branch.
- `collectRedeclaredWithTargetObjects` — its result loop `continue`s on
  `!withTargetSymbols.has(symbol)`, and only a `ts.WithStatement` can populate
  that set. The declaration half it also collects is then discarded unread.

### Byte identity (base vs branch)

`npx tsx scripts/prove-emit-identity.mjs`, golden baseline captured with the two
files reverted to `origin/main` (file-copy A/B), then `check` on the branch:

```
[prove-emit-identity] IDENTICAL — all 84 (file,target) emits match baseline. ✓
```

84 = 21 files × 4 targets (`gc`, `standalone`, `wasi`, `linear`) — the 15-file
default corpus (`website/playground/examples` + `scripts/emit-identity-corpus`),
plus a 6-file `with` corpus written for this issue and passed via `--root`,
because the default corpus contains no `with` statement at all and so proves
nothing about the half of criterion 3 that matters. The `with` corpus covers
the redeclared-`with`-target shape `collectRedeclaredWithTargetObjects` exists
for, a realm-global `this.x = {…}` target, a top-level static + dynamic `with`,
`with` inside a `for…in`, a `withDefaults`/`writable` lookalike with no `with`
statement, and a plain `with`-free redeclaration.

### Suites

- **`with`-covering suites** — all 18 `tests/*with*` files, run on base and on
  branch: **6 failed / 139 passed (145) on both**, failing-name diff **empty**.
  The 6 are pre-existing on `origin/main` (#1387 ×2, #3521 telemetry, #4206
  closure-IR ×2, #671 W1).
- **Equivalence** — 8 shards sequential, `EQUIVALENCE_FORK_HEAP_MB=4096`,
  24 known failures in the baseline, no new regressions on any shard.
- **New** `tests/issue-5313-with-scan-gating.test.ts` — 13 tests: the
  pre-filter's one-directional soundness (`withDefaults` reads false), a real
  `with` in four positions reads true, zero traversals when the substring is
  absent, memoization proved on the lookalike (first call really walks, second
  costs 0) and on the positive answer, deterministic bytes for `with` and
  `with`-free programs on gc/standalone/wasi, the redeclared-`with`-target
  widening still producing 20, and the budget drop plus the fact that a
  `with`-bearing fixture still pays for both scans (measured +20,267).
- The three behavioural assertions were run against **base** first and give the
  same answers there, so they lock a preserved invariant rather than new
  behaviour.
- Gates: `check:harness-compile-budget`, LOC/func (with the grants above, also
  under `LOC_GATE_BASE=origin/main`), `check-coercion-sites`,
  `check:oracle-ratchet`, `check:dead-exports`, `check:ir-dialect`,
  `check:ir-kind-neutrality`, `check:jstag-seam`, `check:ir-layering`,
  `check:ir-fallbacks`, `check:host-import-policy`,
  `check:ir-only --policy=hybrid` (READY), `check:standalone-ir-cutover-corpus`,
  `check:pushraw`, `check:stack-balance`, `check:codegen-fallbacks`,
  `check:any-box-sites`, `check:speculative-rollback`, `check:ir-adoption`,
  `check:linear-ir`, `typecheck`, `lint`, `prettier --check` — all pass.
  `check:oracle-ratchet` and `check-coercion-sites` watch `src/codegen` and
  report +0, as expected for a change that adds no checker query and no
  coercion site.
