# IR migration review — Fable architect, 2026-07-24

Verify-first review of the IR migration (goal `ir-full-coverage`, epic #3518)
on main @ `7652f0337`. Every number below marked **[measured]** was re-derived
on today's main in this session; **[not re-measured]** figures are carried from
the 2026-07-21 audit with a staleness assessment.

## 1. Where the migration actually stands

**The compiler today is a default-on hybrid, not IR-only.** Everything still
compiles through the legacy front-end first; IR patches slots over the subset
it claims, and only allowlisted (f64/boolean-signature) functions skip their
legacy body.

Re-derived signals vs. #3518's "Current truth (audited 2026-07-21)" table:

| Signal                                  | #3518 claim                                                                                 | Today (2026-07-24)                                                                                                                                                                                                                                                                          | Verdict                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Playground `body-shape-rejected` bucket | 0                                                                                           | **0** — all unintended buckets 0; only `async-function: 4` (deferred) remains [measured, `check:ir-fallbacks --verbose`]                                                                                                                                                                    | HOLDS                                                     |
| Module-level residual                   | 1 → 0 after #3517                                                                           | **0** — 2 claimable module-init units (calendar 9 stmts, algorithms 1 stmt), 11 empty [measured]                                                                                                                                                                                            | HOLDS                                                     |
| `check:ir-only` lane                    | 5/5 entries, 37 units, 31 emitted, 6 Unsupported, 0 Invariants, 37 legacy bodies, NOT READY | **Identical**: 37 units, 31 IR-emitted, 6 typed Unsupported (`select/async-function`×2, `select/call-graph-closure`×1, `select/body-shape-rejected`×1, `build/static-class-member`×2), 0 invariants, **37/37 legacy bodies emitted**, verdict NOT READY [measured]                          | HOLDS exactly                                             |
| Adoption matrix                         | 18/56 rows IR-owned                                                                         | **18 ir-owned / 28 mixed / 6 direct-only / 6 deferred = 58 kind rows** [measured; `gen:ir-adoption --check` passes, doc fresh]                                                                                                                                                              | 18 ir-owned holds; denominator drifted 56→58 (prose only) |
| IR-first compile-once ceiling           | 441/1,568 (28.1%)                                                                           | **[not re-measured]** — the stride sweep (`scripts/ir-first-sweep.mts`) is too heavy for a review pass. 11 commits touched `src/ir/` since 2026-07-21; they are regression fixes (#680, #3536, #3551, #3553, #3565) and R1 groundwork, not allowlist widening — figure plausibly still ≈28% | ASSUME ≈HOLDS                                             |
| Front-end reachability                  | 59,676 legacy-only fn-lines                                                                 | **[not re-measured]** — #3090 audit artifact; no legacy deletion has landed since                                                                                                                                                                                                           | ASSUME HOLDS                                              |

Additional verified state:

- **R1 (#3520) is genuinely in flight** and already landing groundwork on
  main: `4922ed58b feat(ir): add structural unit identities and shadow ABI
map`, `1a17b4458 chore(ir): claim R1 identity and ABI migration`. (Not
  reviewed further — other lane owns it.)
- The R0 typed-outcome machinery is real, not prose: `check:ir-only` prints
  per-unit typed blockers with stable codes and an invariant channel
  (observed live, e.g. `unpatched-slot`, `missing-terminal-outcome` paths in
  `src/codegen/index.ts` ~1870-1915).

## 2. Is the ratchet honest?

**Mostly yes — with one important correction to the project's own docs.**

- `STRICT_IR_REASONS` (`src/codegen/index.ts:1492`) is an **empty set** on
  today's main. No selector-rejection reason has EVER been promoted to a hard
  error. The CLAUDE.md "IR Fallback Budget" text ("Once a bucket hits zero,
  the rejection reason gets added to STRICT_IR_REASONS") describes an
  aspiration that has not happened for any reason — and per the re-scoped
  #3341 it _should not_ happen as a corpus-zero flip. The in-code comment
  (index.ts:1493-1511) now documents the necessary-but-not-sufficient rule
  correctly.
- **The over-promotion hazard is empirically proven, not theoretical.** Real
  issue-#3341 work (branch `issue-3341-strict-ir-buildorerrors`, merged as
  GitHub PR #3249 on 2026-07-17) activated `STRICT_IR_BUILD_ERRORS` for a
  build invariant; the strictness then broke standalone generators (fixed by
  `8b7547a1d`, "narrow #3341/#3519 STRICT-IR over-promotion") and 3-4
  _designed_ demote-to-legacy contracts (fixed by `b6d1da941`/`4f703c939`,
  issue #3565). Both fixes narrowed the strictness back. Lesson: strictness
  promotions must be per-reason, unreachability-proven, and regression-tested
  against standalone/generator lanes.
- **Audit hazard confirmed:** `git log --grep="#3341"` surfaces "Merge pull
  request #3341" (a bigint PR) and "#3520" (an exactfield PR) — GitHub PR
  numbers, not issue ids. Branch names (`issue-NNNN-*`) and `fix(#NNNN):`
  scopes are the reliable signals; bare merge-subject `#NNNN` is not.
- **Overclaim assessment of "done" ratchet issues (#2855, #2856, #2857,
  #2858, #2859, #2953):** none is a false "done" _as scoped_ — they are
  corpus ratchets and the promotion half of #2855's original AC was
  explicitly carved out to #3341 (still `ready`, unstarted). But their
  evidentiary value is exactly and only "must not regress on the 13-file
  playground corpus". #3518's table already states this honestly.
- **Gate mechanics verified sound:** `check-ir-fallbacks.ts` `diffTable`
  unions baseline+current keys, so a reason _absent_ from
  `ir-fallback-baseline.json` still fails on any occurrence (baseline-0
  semantics). Post-claim demotions are gated must-not-increase and currently
  read "(none)". The ratchet is a genuine downward-only ratchet — just a
  narrow-corpus one.

## 3. What concretely remains (owner map)

Two orthogonal kinds of remaining work — the R-spine gives _ownership/
compile-once infrastructure_; it does NOT by itself close _per-kind lowering
coverage_:

**Owned rows (live owner):**

| Remaining work                                                                                                                 | Owner                                                              | Status                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------- |
| R1–R8 spine (identity/ABI → prepared program → classes → module-init → multi-source → runtime contract → async plans → linear) | #3520 (in-progress, other lane) → #3521–#3528 (blocked, correctly) | on track                                     |
| `SwitchStatement`, `LabeledStatement`, `ForInStatement` (direct-only), labeled break/continue                                  | #2952                                                              | **ready, unstarted — critical path, see §4** |
| `AwaitExpression` / async bodies                                                                                               | #1373b                                                             | in-progress                                  |
| Untyped/dynamic JS values                                                                                                      | #2949                                                              | ready                                        |
| String-mode depolymorph                                                                                                        | #2955                                                              | ready                                        |
| IR↔codegen layering (js-tag below IR)                                                                                          | #3113                                                              | ready                                        |
| Legacy deletion                                                                                                                | #3090                                                              | blocked (correct — behind R9/R10)            |

**Orphaned rows (NO live owning issue) — 28 of the 34 non-ir-owned,
non-deferred matrix rows.** Now tracked by new issue **#3583**:

- **13 rows tracked by #1131, which is `wont-fix`:** ExpressionStatement,
  ForStatement, ForOfStatement, TryStatement, NullKeyword, BinaryExpression
  (`%`, `**`, `in`, `instanceof` all throw), PrefixUnaryExpression,
  ElementAccessExpression, ObjectLiteralExpression, SpreadElement,
  FunctionExpression, ArrowFunction, YieldExpression.
- **12 rows tracked by closed (done) issues:** VariableStatement (#1372),
  ClassDeclaration/ThisKeyword/NewExpression/MethodDeclaration (#1370),
  TemplateExpression/PropertyAccessExpression (#1374),
  ArrayLiteralExpression (#1804), CallExpression (#1371),
  ConstructorDeclaration/Get-/SetAccessorDeclaration (#3000). The class-family
  rows arguably re-home under #3522 (R3) for _ownership_, but per-kind
  lowering residue (computed/generator names, etc.) is unowned.
- **3 rows with no tracking at all:** `AsExpression`/`TypeAssertion`,
  `NonNullExpression` (both should be near-trivial pass-through adoptions),
  `EnumDeclaration` ("(future)").

Goal-doc staleness (minor): `plan/goals/ir-full-coverage.md` lists #2952,
#3113, #2949, #3305 as `in-progress`; their frontmatter says `ready` (#2952,
#3113, #2949). Frontmatter is authoritative.

## 4. Ladder assessment (R0→R8)

The `depends_on` frontmatter of #3520–#3528 matches the epic's spine table
exactly (R2←R1; R3←R2; R4←R2,R3; R5←R1–R4; R6←R2; R7←R3,R5,R6; R8←R5–R7).
R0a/R0b are genuinely done — the typed gate exists, runs, and reports
honestly (it declares its own verdict NOT READY). Sequencing judgment:

- **Sound:** R4 after R3 (module-init consumes the class/static-intent
  census); R6 hanging only off R2 (runtime families can proceed in parallel);
  R5/R7/R8 as integration barriers.
- **Gap 1 — R9 has an unstated prerequisite: coverage closure.** R9
  (fail-closed flip) depends on R3–R8 in the epic, but nothing in the spine
  requires the _syntax coverage_ work first. With `SwitchStatement` /
  `LabeledStatement` / `ForInStatement` direct-only (#2952 unstarted) and
  `%`/`**`/`in`/`instanceof` unlowered, a fail-closed flip would hard-fail
  ordinary core-JS programs. The epic's acceptance gate only catches this if
  the "authoritative matrices" contain such syntax — the playground corpus
  barely does (corpus-blindness at R9). **Recommendation:** make coverage
  closure of every non-deferred adoption row (#2952, #2949, #1373b, #3583
  children) an explicit R9 dependency, and/or expand the `check:ir-only`
  corpus so the gate cannot be green while `switch` is unclaimable.
- **Gap 2 — #2952 is on the R9 critical path but idle.** Its structural work
  (br_table + multi-level labeled exits in the IR node model) depends on
  neither R1 nor R2 — it can start now, in parallel with the spine. It is
  `ready` with an architect-spec-first plan since 2026-07-02.
- **Gap 3 (known/accepted):** R9/R10 have no child issue ids yet — the epic
  says they get ids before dispatch; fine, but they are the only spine rows
  without a file.

## 5. Risk review — silent vs. loud failure

- **Loud (good):** post-R0, a claimed unit whose slot is neither patched nor
  error-reported becomes a typed **Invariant** (`unpatched-slot`,
  `missing-terminal-outcome` — index.ts ~1890-1915). Resolve-time demotions
  are typed (`unsupported/type-resolution-unsupported`), recorded on
  `irPostClaimErrors`, and gated must-not-increase by `check:ir-fallbacks`
  (currently "(none)").
- **Quiet by design (watch):** severity-`warning` demotion channels
  (index.ts ~2359, ~2409) never fail a build. Their only CI backstop is the
  post-claim baseline — which is empty, so any first regression _is_ caught,
  but only on the playground corpus. Real-world demotions on user code remain
  invisible outside `JS2WASM_LOG_IR_FALLBACKS=1`.
- **The principal silent-miscompile surface is hybrid divergence, not the
  demotion mechanism:** when IR and legacy lower the same construct with
  different value representations, a function's observable behavior can
  change with claimability (refactor a body → different engine). The #3565
  guard-audit lane's finding of three _invisible_ standalone regressions
  (#3566/#3567/#3568, filed 2026-07-22) shows this boundary is an active
  defect source. This risk only fully dies at R9/R10 — one more reason the
  spine matters more than bucket-zero cosmetics.
- **#1930 V1 negative-zero miscompile — VERIFIED FIXED.** The recorded live
  miscompile (`isI32SafeExpr` minus-arm accepting unary `-x`, collapsing
  `-0` under i32 promotion) was fixed on main by `20569059b` ("fix(#1930):
  Slice 3 salvage — V1 scalar -0 miscompile fix + boolean spine extraction",
  2026-07-18); the minus-arm now admits only `-<non-zero integer literal>`
  (function-body.ts:458-473). Empirically re-verified this session with a
  fresh probe (`.tmp/probe-1930-neg-zero.mts`, not committed): `1/(-x)` with
  `x=0` returns `-Infinity`. The stranded branch
  `upstream/issue-1930-slice3-i32-matchers` still exists and still carries
  ~1.4K lines not on main (oracle/i32-safety doctrine tests + declarations
  refactor) — the _fix_ is salvaged, the rest needs a deliberate
  extract-or-discard decision by the #1930 owner. Do not merge the branch.

## 6. Prioritized completion plan

1. **Land R1 (#3520)** — in flight, other lane; hands off. Then unblock R2
   (#3521). The spine order is correct; don't reorder it.
2. **Start #2952 now, in parallel** (architect-spec slice choosing Design A:
   labeled nested-buffer exits + `br_table`). It is the longest-lead
   _coverage_ item on the R9 critical path and independent of R1–R4.
3. **Adopt #3583** (this review's new issue): triage the 28 orphaned matrix
   rows — class-family rows re-home under #3522; expression-lowering residue
   gets per-family owners (or folds into #2949/#2952); `AsExpression`/
   `NonNullExpression`/`EnumDeclaration` are cheap standalone adoptions.
4. **Amend #3518's R9 row** to name coverage closure as an explicit
   dependency (see §4 Gap 1) and/or grow the `check:ir-only` corpus beyond
   the playground so R9 readiness is measured against real syntax breadth.
5. **Keep #3341 parked** until per-reason unreachability is real (post-R2 at
   the earliest). The 2026-07-17/22 over-promotion regressions are the
   cautionary tale; corpus-zero is necessary, never sufficient.
6. **Continue #1373b** (async CPS) — R7 consumes it; it is already
   in-progress.

## Bottom line

The migration's _measurement_ is honest and current (all re-derived numbers
match the epic's audit), the _ratchet_ is sound but narrow, and the _spine_
is well-sequenced with one real hole: nothing forces syntax-coverage closure
before the fail-closed flip, and the biggest coverage item (#2952) plus 28
orphaned adoption rows (#3583) have been sitting ownerless while the spine
advances. The direct front-end remains 100% reachable today (37/37 gate
units still emit legacy bodies); deletion remains correctly gated behind
R9/R10.
