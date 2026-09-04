---
agent: arch-spine-takeover (architect, Fable lane)
date: 2026-09-03
base: origin/main 4fa179f85f ("Merge pull request #5527")
scope: audit only — no code, no PR beyond this docs commit
inputs: "#3518 §Dependency spine, #3520/#3521/#3522/#3523/#3525/#3526/#3527/#3528, #4522, plan/agent-context/ir-migration-handover-2026-08-28.md (+ its 2026-09-03 addendum on origin/claude/docs-wave9-followups)"
---

# Spine takeover audit — 2026-09-03

## (a) Verdict

**The spine is not blocked on design; it is blocked on one stale claim, three
in-flight PRs holding four hot files, and a dispatch gate that cannot tell a
sibling R-row from a competitor.** Measured on `origin/main 4fa179f85f`: R1's
whole published checkpoint chain C33–C39 has landed (last: PR #5345), R2's
ranked next slice R2-F1 landed in PR #5507 and its telemetry predecessor
R2-T1/G1 in `ae390a2e12`, R4's string slice R4-M1 landed in PR #5511 and its
census prerequisite #5285 in PR #5515, R6's Family 3 has landed S1 (PR #5487)
and S2 (PR #5504). **Only R3 has not moved since 2026-08-29** — and the reason
is not technical: `ttraenkler/opus-3522-f4` still holds the bare-id claim, its
branch `claude/issue-3522-f4-field-call-admission` is an ancestor of main with
**0 commits ahead**, its PR #5199 merged 2026-08-29T04:27:46Z, and no `*3522*`
branch has moved since 2026-08-22. The one argument for leaving it — that a
live codex lane might still be inside it — **died today with the codex lane**,
so the claim is stale and must be released. Everything else on R1–R6 has a
named, measured next slice; four of the eight I recommend already carry a
plan-grade brief and four need a plan whose first job is a re-measurement (R1's
red-test count and R4's firing-arm confirmation are both stated in the issues as
*must re-measure before briefing*). R7/R8 remain correctly blocked and
unclaimed. Two audit hazards to carry: `pre-dispatch-gate.mjs` returns **STOP
for every R-spine row** purely because the sibling rows cite each other, and
`gh` is **not installed in this container**, so the gate's open-PR check
silently degrades to a warning — neither exit code should be read as a real
blocker without the per-row reasoning below.

## (b) Per-row state — R1…R8

Claim column quotes `node scripts/claim-issue.mjs --check <id>`; every record
was **read from `origin/issue-assignments`** (the tool printed that ref on each
call). Gate column is `node scripts/pre-dispatch-gate.mjs <id>` exit code.

| row | issue | status on main | done checkpoints (cite) | what remains | smallest next slice | plan? | conflict surface | claim (read `origin/issue-assignments`) | gate |
|---|---|---|---|---|---|---|---|---|---|
| **R1** | #3520 | `in-progress`, updated 2026-08-22 (frontmatter is stale vs the code) | C33 branded/authority (PR #5210 `71cb459a98`, `0ccfd486ae`); C34 accessor order (PR #4729/#4733 `eb00aad585`, `20ccceaa27`); C35 residue → positional fallback **40→15→0** (PR #4747 `7ff420e4b7`,`c216392e47`,`81444b98ae`,`07036ce4df`); structural Program-ABI ownership (PR #5233 `ee5db545bc`,`2904ff7049`); C36 vec fail-closed (PR #5294); C37 user-vec preservation (PR #5295 `cc6d5979a9`); C38 ctor-closure provenance (PR #5342 `f8eefc6e9a`); C39 Date carrier provenance (PR #5345 `b39a839e58`); census follow-up `7c38ab8b7b` | the issue's own `## Resume checkpoint` "Remaining, in order" items **1–4**: (1) route residual `funcMap`/`structMap`/module-array/display-name scans through `LegacyAbiAdapter`; (2) exports as explicit Program-ABI aliases; (3) notify the session from allocator replacement / dead-type elimination / compaction; (4) **clear the 18 red `tests/issue-3520-*`** before any R1 acceptance claim | **item 4 first, and it starts as a measurement.** The "18 red in 15 files" figure is dated 2026-08-22 at `81edcbcaa` — six checkpoints have landed since. Re-run the 61 `tests/issue-3520-*.test.ts` on `4fa179f85f`, publish the current red set, then take the largest single-cause cluster (the vec/closure export-displacement cluster, rows 1–3) as one PR | **needs plan.** A plan must first measure: current red count/names at `4fa179f85f`; which of them C36–C39 already fixed; and which of the 4 "probable compiler defects on main" survive | `tests/issue-3520-*.test.ts`, `src/codegen/program-abi-*.ts`, `src/codegen/ir-legacy-caller-abi.ts`, `src/codegen/compiler-support-abi.ts` | `NO ACTIVE CLAIM, id TAKEN (released, ttraenkler/codex, 2026-09-03T09:40:24Z)` — exit 0 | 1 (STOP — all 8 blockers are sibling R-rows + #2949/#4588 citing #3520) |
| **R2** | #3521 | `in-progress`, updated 2026-09-02 | R2-v2 collector repair (2026-08-29 record); fast typed-scalar pre-body admission (2026-08-30); production body-emission accounting checkpoint (2026-08-30); fast JS-host pass-through string signature (2026-09-01); **R2-T1/G1** withdrawal telemetry + `tests/ir` under CI (`ae390a2e12`, plan `ae4e63b5f8`); **R2-F1** fast-lane mixed string/scalar admission (PR #5507 `f168266db5`) | the issue's own two "After this slice" ranked tables. Rank 1 (R2-F1) is **done**. Live: #5278 selector callable-equality pre-claim gap; **R2-E1** extern/reference-carrier certification (4 `callable-param` rows + the 5 all-lane `(1,1,1)` shapes); R2-S1 storage edge (8 rows, downstream of R4); the `(1,1,1)` dead-residue byte/import question; the R2-v2 24-child run | **R2-E1** — certify the 4 `callable-param` outside-caller rows. It is the largest single-source residue and R2-T1's attribution (now landed) was its stated precondition | **needs plan.** Must measure first: the current `callable-param` row count on the 486-cell census after R2-F1, and whether the `el`/`bcrd` exclusion still holds (the record says it was measured once and is *not* R2-E1's population) | `src/codegen/ir-prepared-free-functions.ts` (`:856`, `:890`, `:1422`) — **held by in-flight PR #5528**; `src/codegen/ir-overlay-outcomes.ts` — **held by in-flight PR #5530** | `NO ACTIVE CLAIM, id TAKEN (released, ttraenkler/codex, 2026-08-30T22:46:51Z)` — exit 0 | 1 (STOP — sibling rows) |
| **R3** | #3522 | `in-progress`, updated 2026-08-29 — **frozen for 5 days by a ghost claim** | F1 refresh `2b1f6b2aa8`; F2 exact-owner direct-call plans (2026-08-27 checkpoint); **F4** prepared field-call family (PR #5199 `0d7c62df0d`, `44e179c545`) merged 2026-08-29T04:27:46Z; the class-family slice records for nested accessors (08-15), initialized instance fields (08-16), static methods (08-22) | the 7–8 class units in the 2026-09-03 dogfood census: `class-member-unsupported` ×4, `class-projection-unsupported` ×2, `class-method` ×1, plus `static-class-initialization` ×1 on the module-init side. Also unresolved from F4: implicit / externref-backed / unsafe-super / forward-ABI / nested-class / closure class families | **step 0 is `node scripts/claim-issue.mjs --release 3522 ttraenkler/opus-3522-f4`.** Then: one PR over the `class-member-unsupported` ×4 cluster, after an arm-level census (`JS2WASM_IR_SHAPE_DIAG=1` + `trackIrOutcomes`) says all four fire on the same arm | **needs plan.** A plan must measure first: which reject **arm** (`detail`), not bucket (`code`), each of the 7 units fires on — #3523's retraction and #3518's `unitKind` method note both say a reason label names a demote path, not a feature area. **And R3 is very likely under-counted**: #3518's 2026-09-03 representativeness measurement puts `PrivateIdentifier`+`PropertyDeclaration` at 8.9% of test262 nodes vs 0.4% of both our corpora | `src/ir/select.ts` (class arms), `src/codegen/class-bodies.ts`, `src/codegen/prepared-class-body-cutover.ts`, `tests/issue-3522-*`. **Avoid** `src/codegen/index.ts::planIrOverlay` (the F4 admission marker lives there) while PR #5530 is open | `CLAIMED by ttraenkler/opus-3522-f4 (since 2026-08-28T22:01:28Z)` — exit **3**. **STALE — RELEASE.** Evidence: PR #5199 merged 08-29; branch is an ancestor of `origin/main` with **0 ahead**; no `*3522*` branch moved since 2026-08-22; no session row for that agent; and the only reason the 09-03 record gave for not releasing (a possibly-live codex lane) is void now that lane is retired | 1 (STOP — **and here the claim blocker is real**) |
| **R4** | #3523 | `in-progress`, updated 2026-09-02 | gap-1a/1b/2b/3/4/6a branch series; **R4-M1** string module-binding storage (PR #5511 `e567b755cc`); **#5285** non-short-circuiting module-init refusal survey (PR #5515 `9909df5963`) — the census prerequisite both carrier checks demanded | module-init compile-once. Measured adoption on dogfood: **0 of 19 executable single-host, 0 of 16 executable standalone** (#3518's 2026-09-03 verification pass; the older "0 of 20" used the population, not the executable subset). Blocked declarations by declared type: `any` 27 / `function` 9 / `ambient-import` 6 / `destructuring` 3 / `bigint` 2 / `array` 2 / `object`,`null`,`undefined`,`Ctor` 1 each; `string` is now **0** | two, in this order: (i) **#5297** — symbolize the compat-lane externref dynamic support surface, which is the blocker PR #5525 uncovered and deliberately left (`implicit-support-reference-unavailable`, `src/ir/prepared-component-dependencies.ts:434-437`); this unlocks the `any` slice worth **4 files**. (ii) the **`function`** storage slice (2 files, carrier verified clean: `(mut externref)` on both lanes) | (i) **#5297 has a plan-grade brief** (files, line anchors, 5 acceptance criteria, conflict surface) but **no `## Implementation Plan` heading** — and it is on `origin/claude/docs-wave9-followups`, not on main. (ii) **needs plan**, and the issue itself names the required first measurement: confirm `arrow-params.js` / `generators-async.js` refuse at the **storage** arm, not a shape arm — `escapes-unicode.js` was attributed to `object` and actually fires `body-shape-rejected` | (i) `src/ir/prepared-component-dependencies.ts`, `src/ir/program-abi.ts`, `src/ir/integration.ts`, `src/codegen/any-helpers.ts`. (ii) `src/ir/module-bindings.ts`, `src/ir/module-binding-value-kinds.ts`. **Both collide with in-flight PR #5525** | `NO ACTIVE CLAIM, id TAKEN (released, ttraenkler/opus-3523-scalar, 2026-08-28T22:28:11Z)` — exit 0 | 1 (STOP — sibling rows + ES2015 rows citing #3523) |
| **R5** | #3525 | `in-progress`, updated 2026-08-30. **The spine table's "blocked" is stale — R5 has been landing slices for a week** | M0/M0.1 telemetry-only owner lifecycle (2026-08-28 checkpoint); M1A.1 unit-keyed direct-body consumption; M1A.2 default-on bounded callable components; M1A.3 same-spelling exclusion retired; **M1A.4a** graph-first callable alias reconciliation (`396351da6c`, 2026-08-30); prepared-publication gap closure (`24b91d5cdf`, `868be0c403`) | the **full M1A.4** remainder — anonymous-default + namespace-call — then M1B (make the frozen program signature fast-mode aware) then M2 (classes, closures, globals, ordered module init) | **the M1A.4 remainder.** Its two stated blockers are now **gone**: `src/ir/from-ast.ts` was held by PR #5218 (merged, `f6de3f79de`) and `src/ir/propagate.ts` was reserved by the #3521 lane whose R2-T1/G1 + R2-F1 both landed. Re-verify both before briefing | **needs plan** — the M1A.4 lock exists (2026-08-30, `:1594`) but its landing correction (`:1797`) explicitly deferred the two seams and requires the plan be *refreshed against the exact main ancestors* of the owners that have since landed | `src/ir/propagate.ts`, `src/ir/from-ast.ts` (namespace-call seam), `src/ir/program-callable-selection.ts`, `src/codegen/multi-prepared-callable-*.ts` | `NO ACTIVE CLAIM, id TAKEN (released, ttraenkler/codex, 2026-09-03T09:40:40Z)` — exit 0 | 1 (9 blockers, all sibling/related rows) |
| **R6** | #3526 | `in-progress`, updated 2026-09-02. Also **not "blocked"** in practice | Family 1 (number/boolean/generator/residual boundary) complete; Family 2 string/text **complete at manifest level** (2026-09-02 close-out, F2-S1…S8); Family 3 census + slice map F3-S1…S6; **F3-S1** host callback maker under manifest policy (PR #5487); **F3-S2** capability-record schema widening (PR #5504 `1bf78accba`, plan `c9c134ec29`) | F3-S3 (`functionPrototypeCall` policy, **S**), F3-S4 (closure-environment policy, M — needs a record kind F3-S2 did not add), F3-S5 (publish host dispatch exports, L), F3-S6 (unmatched-callee host fallback, XL, the only non-byte-neutral one). Families 4–6 unstarted | **F3-S3** — one policy, one runtime symbol, truth table `standalone && !wasi`. Smallest thing on the whole spine that still advances a row | **needs plan.** The slice map row is a contract sketch, not a plan; and it carries one open question the plan must settle: *build-time vs resolve-time demote* (census open question 4) | `src/ir/runtime-manifest.ts`, `src/ir/integration.ts:6332-6337`. **`integration.ts` collides with in-flight PR #5525 and with #5297** — F3-S3 must be sequenced behind both | `NO ACTIVE CLAIM, id TAKEN (released, ttraenkler/codex, 2026-09-01T09:12:17Z)` — exit 0 | 1 (7 blockers, all sibling rows) |
| **R7** | #3527 | `blocked`, updated 2026-08-20, `depends_on: [3522, 3525, 3526]` | — (no implementation checkpoints; 413-line design record) | everything. Correctly gated on R3/R5/R6 | none — do not dispatch | n/a | `src/ir/` async plan surface (unowned) | `RESERVED — id TAKEN, nobody working (2026-07-21T13:44:42Z)` — exit 0 | not run (blocked) |
| **R8** | #3528 | `blocked`, updated 2026-07-21, `depends_on: [3525, 3526, 3527]` | — (297-line design record) | everything. `JS2WASM_LINEAR_IR` is R8's own escape hatch and is also R9 debt | none — do not dispatch | n/a | `src/codegen-linear/`, `src/ir/backend/linear-integration.ts` | `RESERVED — id TAKEN, nobody working (2026-07-21T13:49:38Z)` — exit 0 | not run (blocked) |

**Two gate caveats, both load-bearing.**

1. **Every R-spine row returns exit 1 (STOP) for a structural reason, not a
   real one.** The blockers are the sibling R-rows: #3520 cites #3522, #3522
   cites #3523, and so on — all `status: in-progress` by construction, because
   the epic keeps them open. Reading exit 1 as "someone owns this" would freeze
   the entire spine. The only *real* claim blocker the gate found is #3522's,
   and that one is stale.
2. **`gh` is not installed in this container**, so every gate run printed
   `` `gh pr list` returned nothing — offline or unauthenticated ``. The
   open-PR half of the gate did not run. Section (e) is the hand-substitute.
3. **#5300 is a live demonstration of the PR-number/issue-id collision trap.**
   Its two "ACTIVE overlap" blockers (#4444, #5194) are references to
   *pull request* #5300 (a TypedArray slice), not to *issue* #5300. Verified by
   reading both files. Gate exits: #5297 → **2** (CAUTION, only because the
   issue file is not yet on main), #5299 → **2** (same), #5300 → **1** (STOP,
   false positive), #5283 → **1** (STOP; blocker is #3518 itself citing it).

## (c) R9 reader list — the retirement denominator, one PR each

Re-verified against `src/` on `4fa179f85f`. #4522's table is the source; every
line number below was re-grepped today, and all 14 route/representation readers
still exist exactly where the inventory says.

### The 14 inventoried route/representation readers (#4522's `retire-at-R9` set)

| # | reader | file:line | off-value effect |
|---|---|---|---|
| 1 | `JS2WASM_IR_FIRST` | `src/codegen/index.ts:5663` (consumer), `:3920`, `:5821` (telemetry), `src/codegen/multi-prepared-callable-orchestration.ts:1264`, `src/ir/select.ts:383` | `=0` disables IR-first legacy-body skipping — forces compile-twice |
| 2 | `JS2WASM_IR_STRING_BUILDER` | `src/ir/string-builder-shape.ts:113,129`, `src/codegen/multi-prepared-callable-orchestration.ts:1245` | `=0` forces builder loops to legacy |
| 3 | `JS2WASM_IR_ASYNC` | `src/codegen/context/create-context.ts:448` (doc `src/codegen/context/types.ts:4129`) | `=0` clears `supportsAsyncIr` — async bodies route to legacy |
| 4 | `JS2WASM_IR_MIXED_PRIMITIVE_CONDITIONAL` | `src/ir/select.ts:6995,7166`, `src/ir/from-ast.ts:11871`, `src/codegen/ir-first-gate.ts:254` | `=0` rejects the exact mixed-primitive route pre-claim (owned by #5092) |
| 5 | `JS2WASM_MULTI_PREPARED_SCALAR_LEAF_CUTOVER` | `src/codegen/multi-prepared-callable-orchestration.ts:1274` | `=0` restores direct-first for the scalar leaf |
| 6 | `JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER` | `…orchestration.ts:1275` | ditto, array leaf |
| 7 | `JS2WASM_MULTI_PREPARED_STRING_CUTOVER` | `…orchestration.ts:1276` | ditto, counted-string benchmark leaf |
| 8 | `JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER` | `…orchestration.ts:1278` | ditto, benchmark loop leaf |
| 9 | `JS2WASM_MULTI_PREPARED_FIB_PAIR_CUTOVER` | `…orchestration.ts:1279` | ditto, Fibonacci pair |
| 10 | `JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER` | `…orchestration.ts:161` | `=0` keeps cross-source callable components non-Prepared |
| 11 | `JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER` | `src/codegen/multi-prepared-module-init.ts:137` | default **off**; `=1` enables the Prepared module-init route |
| 12 | `JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER` | `src/codegen/prepared-class-body-cutover.ts:112` | `=0` restores the legacy standalone class-body route |
| 13 | `JS2WASM_PREPARED_TIMER_SHIM_CUTOVER` | `src/codegen/ir-timer-shim-planning.ts:79-80` | `=0`/`false` restores the direct timer-shim body |
| 14 | `JS2WASM_LINEAR_IR` | `src/ir/backend/linear-integration.ts:381` (comment `:17`) | `=0` restores byte-identical direct-backend ownership (R8 then R9) |

### The 7 hatches #4522 found on 2026-09-03 that are **not** in its own table

All re-read at their sites today; **each is a separate PR-sized decision.**

| reader | file:line | classification |
|---|---|---|
| `JS2WASM_STRICT_FALLBACKS` | `src/codegen/fallback-telemetry.ts:81,87` | **retire-at-R9** (subsumed: R9 *is* "IR failure stops demoting silently"). Already effectively on in CI |
| `JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC` | `src/codegen/declarations/module-init-closure-prelift.ts:132` (`DISCOVERY_STATIC_ENABLE_SEAM`) | **retire-at-R9** — same shape as row 11 |
| `JS2WASM_DIRECT_CALLS` | `src/codegen/typed-this.ts:303,323,768,776,787` | **axis call needed** — source calls it a kill-switch twice, but it gates devirtualization *inside* `src/codegen/`, i.e. backend lowering, which `docs/architecture/codegen-axes.md` says stays |
| `JS2WASM_PINNED_THIS_DIRECT_CALLS` | `src/codegen/typed-this.ts:1730` | axis call needed (sibling of the above) |
| `JS2WASM_FIXED_ARITY_HOST_CALLS` | `src/codegen/expressions/host-call-fallback.ts:20`, `src/codegen/closure-exports.ts:1280` | axis call needed — `=== "0"` literally selects a variable named `legacyArrayAbi`. #3526's F3-S2 plan independently flagged it. **Look at this one first** |
| `JS2WASM_NUMERIC_ADMISSION` | `src/codegen/analysis/mixed-assignment-carrier.ts:301,308` | axis call needed — `=0`/`off`/empty "restores the" prior carrier behaviour |
| `JS2WASM_PROXY_MODULE_ESCAPE_GATE` | `src/codegen/declarations.ts:2560` | axis call needed — `!== "0"`, a disableable escape gate |

So the R9 env denominator is **14 or 16 or 21**, depending on the axis call; the
inventory currently says 14. That decision is itself a one-PR docs slice and
should be taken before any R9 flip is scheduled.

### Non-env R9 readers (same retirement, different mechanism)

| reader | file:line | note |
|---|---|---|
| `experimentalIR?: boolean` public option | `src/index.ts:830`, `src/codegen/context/types.ts:259`, `src/ir/select.ts:430` | the global hybrid switch; also the sanctioned *observational* direct oracle in the #4522 Math retirement — R9 must decide whether the oracle survives the option |
| `disableIrFirst?: boolean` public option | `src/index.ts:847`, `src/codegen/context/types.ts:268`, consumed `src/codegen/index.ts:5663` | per-compile opt-out of the compile-once inversion (#2973) |
| `STRICT_IR_REASONS` | `src/codegen/index.ts:2135` (empty set), consumers `:2846`, `:3172-3174` | the promotion mechanism, not a hatch. **Currently empty** — every selector rejection still demotes silently. R9's flip is, mechanically, filling this set |
| codegen-side twin of the above | `src/codegen/fallback-telemetry.ts:67,94` | "empty in Phase 0", identical three-level lifecycle |
| gate denominator | `scripts/check-ir-only.ts:14-20` (`SINGLE_HOST_ENTRIES`, 5 files), `:29` (`STANDALONE_ENTRIES` = same 5) | **this is the reason the gate says READY.** #3518's 2026-09-02 measurement: widening to the playground's other 8 flips it to NOT-READY with 10 (single-host) / 14 (standalone) real direct-body emissions |
| `IrOnlyLaneReadiness` | `scripts/check-ir-only.ts:48-58` | `"baseline"` vs `"ir-only"`; the mechanism R9-D1 wanted to use. **Note `evaluateIrOnlyReport` fails immediately on a lane present in code and absent from `scripts/ir-only-baseline.json`, so a new lane cannot be landed report-only** |
| `TEST_POISON_DIRECT_*_BODY` family | `src/` (~54 `JS2WASM_TEST_*` injectors) | **R10**, not R9 — they become meaningless only once the direct front end is deleted |

## (d) Proposed 2-wave dispatch

Wave 1 slices have **pairwise disjoint file sets** and are disjoint from the
three in-flight PRs *except* where noted as strictly sequenced. Wave 2 assumes
#5525/#5528/#5530 have merged.

### Wave 1 — 4 slices

| slice | issue | files it owns (nothing else) | plan? | sequencing |
|---|---|---|---|---|
| **W1-A — R3 class-member family** | #3522 | `src/ir/select.ts` (class arms), `src/codegen/class-bodies.ts`, `src/codegen/prepared-class-body-cutover.ts`, `tests/issue-3522-*.test.ts` | **needs plan** — arm-level (`detail`) census of the 7 class units first | **step 0: release the ghost claim** (`claim-issue.mjs --release 3522 ttraenkler/opus-3522-f4`), then re-claim per slice (`3522:<slice>`), never the bare id |
| **W1-B — overload call-site plan** | #5300 | `src/ir/from-ast.ts` (direct-call lowering `:6520-6526`) + the `directCalls` writer in `src/ir/`, `tests/issue-3519-ir-outcomes.test.ts` (the fifth test only) | **needs plan** — the issue names the first step (dump `cx.directCalls` keys) but not which of two mechanisms; the fix differs | after **#5530** (it rewrote that test's skip comment). Issue file is on `origin/claude/docs-wave9-followups` — land that docs PR first |
| **W1-C — legacy-body receipt truth** | #5283 | `src/codegen/ir-overlay-outcomes.ts` (`reconcileIrOverlayOutcomes` `:878-879`), `src/ir/module-init.ts` (`collectModuleInitPopulation` `:9-28`), `src/codegen/legacy-body-audit.ts` (`:303`, `:312`, `:500-506`) | **plan exists** — `## Implementation Plan` at `plan/issues/5283-…md:102`, on main | strictly after **#5530** (same file, reshaped there) |
| **W1-D — R1 red-test closure** | #3520 | `tests/issue-3520-*.test.ts`, `src/codegen/program-abi-*.ts`, `src/codegen/ir-legacy-caller-abi.ts`, `src/codegen/compiler-support-abi.ts` | **needs plan** — must open with a re-measurement of the 18/15 figure at `4fa179f85f`; six checkpoints landed since it was taken | independent; can start now |

Disjointness check: `select.ts`+`class-bodies.ts` (A) ∩ `from-ast.ts` (B) ∩
`ir-overlay-outcomes.ts`+`module-init.ts`+`legacy-body-audit.ts` (C) ∩
`program-abi-*.ts` (D) = ∅. None of the four touches
`src/codegen/index.ts`, `src/codegen/ir-prepared-free-functions.ts`,
`src/ir/integration.ts` or `src/ir/module-bindings.ts` — the four hot files.

### Wave 2 — 4 slices (after #5525/#5528/#5530 land)

| slice | issue | files it owns | plan? | sequencing |
|---|---|---|---|---|
| **W2-A — R4 compat dynamic symbolization** | #5297 | `src/ir/prepared-component-dependencies.ts` (`:434-437`, `:460`), `src/ir/program-abi.ts` (`:82`), `src/ir/integration.ts` (module-init preparation, `:727`), `src/codegen/any-helpers.ts` | **plan-grade brief, no `## Implementation Plan` heading** — promote it to one, or accept the brief as the plan and say so | strictly after **#5525**; it builds on that admission arm. Holds `integration.ts` for the whole wave |
| **W2-B — R4 `function` storage slice** | #3523 | `src/ir/module-bindings.ts`, `src/ir/module-binding-value-kinds.ts`, `tests/issue-3523-*` | **needs plan**, and the issue dictates its first measurement: confirm `arrow-params.js` / `generators-async.js` fire the **storage** arm, not a shape arm | after **#5525** (same files). Disjoint from W2-A |
| **W2-C — prepared-callable receipt triple** | #5299 | `src/codegen/multi-prepared-callable-publication.ts` (`~:171-199`), `src/ir/outcomes.ts` (`:335-360`, only if the optional-triple validation needs tightening) | **plan-grade** (`## Fix` + 5 acceptance criteria); promote to `## Implementation Plan` | after **#5530**. Disjoint from W2-A/B/D |
| **W2-D — R5 M1A.4 remainder** | #3525 | `src/ir/propagate.ts`, `src/ir/from-ast.ts` (namespace-call seam), `src/ir/program-callable-selection.ts`, `src/codegen/multi-prepared-callable-orchestration.ts` | **needs plan** — refresh the 2026-08-30 M1A.4 lock against the exact main ancestors of PR #5218 and the R2 lane, as its own landing correction requires | after **W1-B** (both touch `from-ast.ts`) |

**Named alternate, if a wave-2 slot frees early:** R6 **F3-S3** (`functionPrototypeCall`
policy, size S). Files `src/ir/runtime-manifest.ts` + `src/ir/integration.ts:6332-6337`
— it collides with W2-A on `integration.ts`, so it is a wave-3 head, not a
wave-2 peer. It is nonetheless the cheapest remaining spine slice and should be
planned during wave 2 so it is dispatchable the moment #5297 lands.

**Deliberately not dispatched:** R7 (#3527) and R8 (#3528) — correctly blocked;
the R9-D1 dogfood CI lane — #3518's own npm-comparison measurement says dogfood
is the *worst* denominator available (L1 0.681 to real libraries, 0.705 to
test262) and that the plan "should be dropped, not merely re-argued".

## (e) Conflicts to avoid

`gh` is unavailable here, so this section is built from remote branch diffs
against `origin/main 4fa179f85f`.

| in-flight | branch | files it holds | who must wait |
|---|---|---|---|
| **PR #5525** (#5289, any/unknown module bindings) — released, CLEAN, in queue | `origin/claude/issue-5289-any-binding-abi` | `src/ir/integration.ts`, `src/ir/module-bindings.ts`, `src/ir/module-binding-value-kinds.ts`, `scripts/ir-kind-neutrality-baseline.json`, `tests/issue-5289-*` | **W2-A (#5297), W2-B (#3523 `function`), R6 F3-S3** — all three read or edit `integration.ts` / `module-bindings.ts` |
| **PR #5528** (#5282, fast-arm withdrawal mask) — released, CLEAN, in queue | `origin/claude/issue-5282-fast-admission-mask` | `src/codegen/ir-prepared-free-functions.ts`, `tests/issue-3521-r2-withdrawal-shapes.test.ts` | **R2-E1** (its population lives at `ir-prepared-free-functions.ts:856/:890/:1422`) |
| **PR #5530** (#5263 + #5262, accounting precedence) — draft, CI green on `5404b825` | `origin/claude/issue-5263-5262-reconciler` | `src/codegen/index.ts`, `src/codegen/ir-overlay-outcomes.ts`, `src/ir/body-accounting-note.ts`, `tests/issue-3519-ir-outcomes.test.ts`, `tests/issue-3520-outcome-correlation-identity.test.ts`, `tests/issue-3525-multi-prepared-callable-bindings.test.ts`, `tests/issue-5262-*` | **W1-B (#5300), W1-C (#5283), W2-C (#5299)** — and W1-A must stay out of `src/codegen/index.ts::planIrOverlay` while it is open |
| **#5283** (pending dispatch, plan on main) | — | `src/codegen/ir-overlay-outcomes.ts`, `src/ir/module-init.ts`, `src/codegen/legacy-body-audit.ts` | note the brief's file list said `src/ir/ir-overlay-outcomes.ts`; **that path does not exist** — it is `src/codegen/ir-overlay-outcomes.ts`. `src/codegen/ir-prepared-free-functions.ts` is *not* in #5283's own plan and should stay out of it (it belongs to #5528) |
| **#5297 / #5299 / #5300** (filed, unplanned, **not on main**) | `origin/claude/docs-wave9-followups` | issue files only | land the docs PR before dispatching any of the three, or the dispatcher's `pre-dispatch-gate` reports `no plan/issues/<id>-*.md on main` (observed: exit 2 for #5297 and #5299) |
| **#5298** (kind-neutrality line-pinned evidence, S, tooling) | same docs branch | tooling only | no spine conflict; free filler |

**One more standing hazard.** `scripts/ir-kind-neutrality-baseline.json` is
edited by #5525 and read by #5297's acceptance criterion 5. Any wave-2 slice
that moves the kind-neutrality verdict table will collide there; #5297 says
explicitly the table **must not move**.
