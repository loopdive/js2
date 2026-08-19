# Project Diary

## 2026-05-20 — Sprint 51 close / Sprint 52 start

**Sprint 51 closed** (2026-05-08 → 2026-05-20, 12 days including a week-long pause from context limit + Codex restructuring overlap).

**Results**: 26,777 → 28,147 pass (**+1,370 net**, 65.2%). 70 PRs merged. 34/50 issues done. 16 carried to S52.

**Key wins**: IR retirement gate (#1376) now enforced in CI. Spec-gap wave (#1358–#1382) closed array callbacks, string methods, iterator helpers, promise combinators, class builtins. IR slices #1370–#1374 retired class methods, extern whitelist, destructuring params. Branch audit recovered 10 unmerged PRs (#341–350) now in CI queue.

**Process issues**: Codex force-pushed to origin/main mid-sprint (rolled back); sprint file status drift (4 issues marked wrong); 10 issue files existed only in labs. Labs migration done this session: js2wasm-labs/main now = labs/ (private) + public/ (subtree).

**Sprint 52 started** (2026-05-20). Theme: spec-completeness continuation + wasm closure bridge. 7 dev agents dispatched day 1 on #1396 (+400 passes), #1431–#1434, #1437–#1438. 10 audit PRs in CI. Baseline: 28,147 / 43,160 (65.2%). Target: +1,500 → ~29,650.

## 2026-05-07 — Sprint 49 close / Sprint 50 start

**Sprint 49 closed.** 4-day sprint (2026-05-03 → 2026-05-07). 8 issues merged.

**Landed**: #1290 TS7 forEachChild compat, #1296 dashboard Wasm dogfood, #1297 Hono Tier 5 (Application + middleware), #1299 virtual dispatch fix, #1300 closure outer-param fix, #1301 closure env field-type fix, #1304 typeof externref function fix. Plus #1241 triage.

**Deferred to S50**: closure call dispatch wave 2 (#1298, #1306), lodash Tier 2 blocker cluster (#1302, #1303, #1305), #1126 IR Stage 3, #1292 lodash Tier 2 un-skip.

**Demoted to backlog**: #1223 TDZ async/gen sharing (third deferral, no test262 leverage).

**Sprint 50 started.** Theme: closure/call dispatch correctness wave 2 + #1126 IR Stage 3. Architect spec gating #1298+#1306; senior-dev on #1126 Stage 3. test262 baseline: 27,769 / 48,171 pass (57.7%).

## 2026-05-03 — Sprint 47 close

**Sprint 47 closed.** 3-day sprint (2026-05-01 → 2026-05-03). 631 commits, 50+ issues completed.

**Key results:**
- 26,247 / 43,088 = 60.9% pass (test suite trimmed from 46,632; ~2% net conformance gain)
- **IR migration complete**: Slices 11–14 landed — switch/operators, element access/array literals, String+Array prototype methods, legacy codegen (`expressions.ts`/`statements.ts`) retired
- **Performance**: escape-analysis scalarization, bounds-check elimination, i32 element specialization, pre-size dense arrays, struct field type inference Phase 2, eval/RegExp LRU cache
- **npm library support**: CJS module.exports + require(), optional chaining, ESLint Tier 1/2/3 stress tests, Hono Tier 2/3 stress tests, WeakMap fix, extern round-trip identity fix
- **TypeScript 7**: forEachChild compat helper + TS7 feature flag (#1288, #1290) — 132× cold parse speedup in test262 runner
- **CI quality**: wasm-hash noise filter (#1222), differential test262 (#1246), baseline drift prevention (#1235), runner pool timeout fix (#1227) — 156 false compile_timeouts eliminated
- **Conformance**: class/dstr defaults (408 failures), private fields, logical assignment, WeakMap dispatch, SameValue f64, OrdinaryToPrimitive TypeError, __any_eq i31ref vs HeapNumber

**Carries to Sprint 48:**
- #1223 TDZ async/gen writer+reader (blocked on #1177 Stage 1)
- #1126 int32/uint32 inference (needs architect spec)
- #1177 Stage 1 (needs senior-dev Opus)

**Baseline**: 26,247 / 43,088 = 60.9%
**Sprint 48 begins.** IR Slice 13d (Array methods), int32 inference, Function.bind, compile-timeout cluster, and standalone readiness are the headline priorities.

## 2026-05-01 — Sprint 46 mid-sprint session

**Sprint 46 active.** Started 2026-04-30; this session ran 2026-04-30 → 2026-05-01.
Context at 73% / weekly budget at 19% when compacting.

**PRs merged this session (PRs #94–#118):**

| PR | Issue | Description |
|---|---|---|
| #94 | #1187 | test-runtime JS-string→native-string coercion helper |
| #95 | #1211 | fib-recursive hosted Wasm validator fix |
| #96 | #1210 | string-hash GC pressure (str_copy_tree O(n²) → buffer) |
| #99 | #1169j | IR Slice 10 step B: TypedArray |
| #100 | #1169l | IR Slice 10 step D: Date/Error/Map/Set |
| #101 | #1169k | IR Slice 10 step C: ArrayBuffer + DataView |
| #102 | #1169m | IR Slice 10 step E: Promise (best-effort) |
| #103 | #1212 | Promise resolve/reject regression fix |
| #104 | #1201 | Per-path test262 scores + landing page |
| #105 | #1213 | refresh-benchmarks path fix (LFS migration) |
| #106 | #1203 | Differential testing harness vs V8 |
| #107 | #1204 | Methodology document |
| #108 | #1214 | Benchmark CI runner-noise gate (informational only) |
| #109 | #1215 | Array .join()/.toString() number_toString registration |
| #110 | — | diff-test CI tsx fix |
| #113 | #1198 | Pre-size dense arrays at allocation site (+15 tests) |
| #118 | #1184 | __str_copy_tree depth-bounded worklist (nativeStrings fix) |

**In CI / in progress at compact time:**
- PR #112 (#1218): baseline validator — awaiting baseline refresh then re-run
- PR #114 (#1220): Promise snapshot + prototype cleanup (+29 tests)
- PR #115 (#1221): WasmException outer-catch fix (~256 flaky tests)
- PR #117 (#1219): ArrayBindingPattern iter-close hang fix (26 CT tests)
- dev-3 → #1196 (bounds-check elimination)
- dev-4 → #1197 (i32 element specialization)
- senior-dev-1210 → #1216 (auto-commit benchmark baseline)
- dev-2 → #1217 (smoke-canary CI)
- senior-dev-1205 → #1205 PR #98 (TDZ boxing, in-progress)

**Key findings from investigation sprint:**
- `compile_timeout` in test262 is a **runtime** timeout (combined compile+execute), not a compile-only timeout. The 30s timer in compiler-pool.ts covers both. ~26 are genuine runtime hangs (iter-close bug), ~70+ are load-induced flakes.
- `[object WebAssembly.Exception]` flakiness (256 tests): fork-state poisoning. Outer catches in test262-worker.mjs missed instanceof WebAssembly.Exception → misclassified as compile_error. Fixed in PR #115.
- `Promise.resolve is not a function` (26 tests): Promise missing from _STATIC_SNAPSHOTS → fork contamination. Fixed in PR #114.
- `Cannot redefine property` (23 tests): mixed isolation bugs (3 fixable in PR #114) + real compiler bugs (instanceof TypeError, mapped arguments — deferred to S47).

**Baseline at session compact:** ~27,000 pass (60.2% adjusted for drift); committed baseline shows 25,813 due to runner variance in the latest promoted run. PRs #114/#115/#117 expected to push real rate to ~61%+ once CI confirms.

**Sprint 46 scope expanded mid-sprint:**
- Added credibility track issues (#1201, #1203, #1204) that were originally deferred to S47
- Added CI health issues (#1213, #1214, #1217, #1218, #1219, #1220, #1221) surfaced by investigation
- Added perf issues (#1196, #1197, #1198, #1184, #1216) from sprint 47 to keep team loaded
- Sprint = 1 week of token budget (new rule); pull next sprint's work when current issues drain

**Drift pattern documented:** Every PR today showed the same drift signature: net positive, but 22-30% regression ratio from Promise flakes + Temporal/annexB skip-list baseline staleness. Physical-impossibility override approved for all (PRs #94, #106, #109, #110, #113, #118).

## 2026-04-29 — Sprint 45 close

**Sprint 45 closed.** 6-day sprint (2026-04-23 → 2026-04-29).

**Key results:**
- +554 net test262 tests (baseline 25,276 → 25,830 = 59.8%)
- IR Phase 4 slices 6–10 all landed: generators (#1169f), destructuring (#1169g), try/catch (#1169h), RegExp/extern-class scaffolding (#1169i step A)
- IrLowerResolver refactor (#1185) cleared the per-feature shortcut debt across the IR system
- Competitive benchmark harness built in labs/ — 5 programs × 9 toolchain lanes; Javy static+dynamic split; Porffor and AssemblyScript lanes wired up
- Architecture Decision Records (#1202) and landing page architecture section (#1208) shipped
- CI baseline-drift hardening complete (#1076–#1080, #1192, #1191, #1193)
- #1177 (TDZ closure captures) reverted after 14.7% regressions — deferred to S46
- 3 new benchmark issues filed: #1209 (hosted ESM error), #1210 (string-hash GC timeout), #1211 (fib-recursive type mismatch)

**Baseline**: 25,830 / 43,168 = 59.8%
**Sprint 46 begins.** IR Slice 10 steps B–E, #1177 investigation, credibility track, and benchmark bug fixes are the headline priorities.

## 2026-04-23 — Sprint 43 close / Sprint 44 setup

**Sprint 43 closed.** Short 3-day sprint (2026-04-20 → 2026-04-23). 3 PRs merged:
IR Phase 1 + 2 (#1131, PRs #231 + #258) and CI merge split (#1076, PR #160).
Baseline held at 24,483 / 43,172 = 56.7% — all IR work is infrastructure.

Also in this session:
- **LFS migration** for `*.jsonl`, `*.log`, `*.wasm`, benchmark JSON files
- **GitHub Pages fixed** after LFS migration broke CI checkout (added `lfs: true` to all 6 affected workflows)
- **All GitHub Actions bumped** to Node.js 24-compatible versions (configure-pages v6, upload-pages-artifact v5, checkout v5, setup-node v6, download-artifact v7)
- **labs remote** (`js2wasm-labs`) set up as private repo for experimental/commercial development; `labs/*` branches blocked from origin via pre-push hook
- **Sprint 44 planned** with #1153 (compiler crashes) + #1168 (IR frontend widening) as headline priorities

**Baseline**: 24,483 / 43,172 = 56.7%
**Sprint 44 begins next.**

## 2026-04-24 — Sprint 44 close

**Sprint 44 closed.** 2-day sprint (2026-04-22 → 2026-04-24).

**Key results:**
- +793 net test262 tests (baseline 24,483 → 25,276 = 58.6%)
- IR Phase 3 complete: monomorphize + tagged-unions (#1167c, PR #13)
- IR infrastructure PRs (#1168, #1167a, #1167b, #1167c) all merged — 0 direct test gain but Phase 4 now unblocked
- LFS budget exhausted mid-sprint → baseline promotion CI job failed; fixed with `continue-on-error` workaround (#1078)
- Sprint grew too large (74 issues); 55 carried over to sprint 45

**Baseline**: 25,276 / 43,172 = 58.6%
**Sprint 45 begins with IR Phase 4 (#1169) now unblocked.**

---

## Sprint 48 — 2026-05-03

Single-day sprint running on ~15% remaining weekly budget. Focus: WebAssembly.Exception cascade (lodash/Hono), stress test tier expansion, CI infrastructure.

**Landed**: #1233 (IR Slice 13d), #1236 (i32 saturation), #1269/#1280 (struct field inference Ph3/Ph3b), #1282 (ESLint Tier 1), #1291 (lodash Tier 1b), #1293 (Hono Tier 4), #1294/#1295 (WasmException reclassification + re-throw), #1290 (TS7 forEachChild helper), #1200 (LICM closed with measurement).

**Infrastructure**: agent idle counter in statusline; CI-wait fast-path for test-only PRs; variance escalation pattern calibrated.

**Deferred to S49**: lodash Tier 2 (#1292), closure/virtual-dispatch gap fixes (#1299–#1304), Hono Tier 5 (#1297), GitHub Pages Wasm dogfood (#1296). Hard issues (#1126 int32 inference, #1199 linear-memory) → backlog.

---

## Sprint 50 — 2026-05-07 → 2026-05-08

Sprint 50 ran as a transition sprint: began as "closure/call dispatch wave 2" but pivoted into a large spec-completeness audit. Ended at ~28,140 test262 passes (~58.5%).

**Key work landed**:
- #1311–#1319 wave: await passthrough, closure stack underflow, error message context, Symbol.toPrimitive, import.defer early error
- #1321 Number.prototype formatting — pure Wasm (eliminated JS host)
- #1322 Math.random() — WASI random_get in standalone mode
- #1327 Landing page: per-feature test stats + playground deep-link
- #1334 Spec compliance audit: architect-s51 reviewed all ECMAScript sections, filed 17 targeted spec-gap issues + 7 IR retirement tasks → becomes sprint 51 backbone
- #1343 Boolean/Symbol coercion TypeErrors, #1344 Date formatters, #1347 for-of IteratorClose
- Timeout raised 8s → 30s: eliminates ~36 false compile_timeout regressions per PR

**Infrastructure wins**:
- Per-test compile timeout increased from 8s to 30s (eliminates false CI noise)
- `sprint/50` tag pushed; `sprint-51/begin` tag pushed

**Carry-overs** (blocked or regressions):
- #1311 (PR #264 -5 net), #1312 (PR #257 38 real regressions — function-index shift bug), #1324, #1325, #1326 (CI failures)
- Structural issue #1382 filed: Wasm closures not JS-callable from host (blocks #1338, #1339, #1358)

**Sprint 51 begins**: 25 issues, theme = spec-completeness wave + IR retirement gate. Target: +1,500–1,800 net passes.

---

## Sprint 61 (2026-06-05 → 2026-06-12) — npm-library support + architecture hardening

Began at 30,585 / 43,135 test262 passes (70.9%); closed at 31,267 / 43,135
(72.5%), **+682 net** over the cycle. 91 issues done (0 wont-fix), 84 carried to
sprint 62.

**Key work landed**:
- AnyValue host-bridge cluster (#2063 → #2058 → #2059): per-site externref tag
  dispatch (`__host_eq`/`__host_add`/`__host_compare`) — the −788 comparator
  trap structurally avoided.
- ~45 deep-audit fixes (optional chaining, spread, switch, block scope,
  for-of/for-in, regex VM opcodes, native strings, linear backend, IR reordering,
  fmod/hypot/isStaticNaN).
- Object-literal cluster #2126–#2132; presence-predicate joint spec (#2130+#1991,
  PR #1394).
- Pipeline hardening: 4 queue-rot mechanisms fixed (PR #1408) + baseline-meta SHA
  fix (PR #1413).
- Two architect specs (optional-chain undefined repr PR #1393; presence predicate
  PR #1394), adversarially reviewed.

**Infrastructure / process**:
- Symphony takeover: claims released, acorn gate #1712 blocker landed.
- Wrap-up debt flagged: sprints 55–60 lacked formal closure; sprint 61 closed
  retroactively 2026-06-15 with full wrap_checklist, retro, and this entry.

**Sprint 62 begins**: "Fable architecture sprint" — clean/maintainable/trustworthy/
consistent compiler architecture (one pipeline driver, one coercion engine, value-rep
doctrine, IR verifier, backend symmetry). Flat test262 headline accepted by design;
conformance payoff lands in sprint 63.

## Sprint 65 (2026-06-21 → 2026-06-24) — architecture epics + value-rep substrate

**Baseline**: 31,678 / 43,135 (sprint-65/begin) → **31,776 / 43,135 (73.7%)** at
close (origin/main 5ca4931a7). **Net +98 passes.** 43 issues done (0 wont-fix),
32 carried to sprint 66.

**Key wins**:
- **#1917 single-coercion-engine series COMPLETED** — the marquee architecture
  deliverable. The four divergent coercion matrices unified into one engine:
  Steps 1–3 emitToString/Number/Boolean (#1960/#1962/#1963) + equality E3
  (#1989) merged; E6 (#1992) + #2045 presence work (#1991) landed through the
  queue at close. Byte-neutral / regression-free — banks the spine the s62
  "Fable architecture sprint" set out to land.
- **#2580 value-rep dynamic-read substrate** driven through M3 staging (M0–M2
  landed; M3 B-pre #1986 in flight). The single highest-leverage lever
  (~390 floor / ~1030 ceiling rows); payoff is unlock-shaped this window.
- **Proxy/Promise identity slices**: #1977 class-extends-Promise capability-ctor
  identity (+1), #1984 Proxy apply/construct (14→15), #1981 async-closure
  box-depth.

**Process**:
- **Architect-spec-first mis-fired 3×** on the substrate (#2623-A/-B, #2580 M3
  Stage A) — each handed off with a mis-attributed mechanism; a senior-dev had
  to deep-trace before a regression-free slice landed. Keeper: trace-first,
  spec-as-hypothesis for value-rep/substrate work.
- **Per-process sharded runner + merge_group standalone floor (#2097)** are the
  only trustworthy broad-impact signals — never in-process loops.
- The **dedicated PR-queue shepherd** standing role held; one-shot enqueue,
  never re-enqueue (no merge-queue churn this session).

**Carried to sprint 66**: the #2580 spine (M3→M4), the IR effect-model lane
(#1373b/#2134/#2135/#2138/#2140/#2141), async/Promise (#1042/#2613/#2614),
Proxy (#1355/#2618), standalone residual tails, type-oracle/pipeline refactors.

## Sprint 66 (2026-06-24 → 2026-06-26) — architecture continuation: value-rep substrate + conformance fixes

**Baseline**: 31,853 / 43,135 (sprint/65 close) → **32,158 / 43,135 (74.6%)** at
close (sprint/66 tag, PR #2146). **Net +305 passes.** 22 issues done + 1 wont-fix
(#1762 linear-memory string backing deferred), 54 carried to sprint 67.

**Key wins**:
- **merge_group standalone floor caught THREE host-masked regressions** (#2124/#2134
  and one more in the #2140-#2142 range) — each recovered via diagnose→narrow→
  re-validate. The floor has now caught host-masked regressions in every sprint
  since #2097 wired it. Non-negotiable for broad-impact PRs.
- **Verify-first architecting shrank "hard substrate" issues**: #2724 accessor-rep
  (1 guard, closes #1642 — framed as a substrate rebuild, confirmed as 1 edit) and
  #2722 nested-optional Path A (2 edits, not expected ~150 LOC). The s65
  retro "spec-as-hypothesis" discipline proved out again.
- **2026-06-26 session landings**: #1551 (SuperCall try-region guard — speculative-
  rollback-eats-side-effects defect); #2671 three sub-areas (JSON.stringify +
  Date.set* + RegExp lastIndex); #2692 (closure-capture ref-cell eager
  materialization); #2713 (IR↔legacy parity correctness twins); #2711 (cross-backend
  differential parity advisory CI gate); #2710 slices 0–1 (late-bind module indices
  foundation, byte-identical); #2709 (super[super()] PutValue ReferenceError).
- **Earlier s66 landings**: #2045 (linear Uint8Array WASI corruption), #2637 (Promise
  capability protocol), #2652/#2654 (parseFloat ToString + precision), #2656/+#2664
  (acorn tokenizer ++this.field fix → 8th dogfood blocker), #2665 (dashboard
  feature-labels from pass-rates), #2667 (mapped arguments), #2675 (computed key
  ++/--), #2677 (chained this-assignment), #2678 (Date.parse host mode), #2679
  (valueOf wrong `this`), #2683/#2684 (Node Messaging + Deno stdio), #2083
  (host-glue size).

**Process**:
- The **standalone floor + diagnose→narrow→re-validate cycle** is the definitive
  broad-impact discipline. Anticipate it; one-shot enqueue only after the floor passes.
- **Verify-first before the architect spec** — confirmed site first, document mechanism
  second. The "substrate rebuild" framing is usually wrong; per-process tracing finds
  the real site.
- **Dev enqueue lag is structural**: dev agents complete fixes but the final enqueue
  step falls to the lead/shepherd. The dedicated PR-queue shepherd role is the designed
  mitigation; staff it at sprint start.
- **statusline-sprint bug fixed**: a `status: planned` sprint was hijacking the active
  badge. Guard committed 2026-06-26.

**Carried to sprint 67**: 54 issues — the #2580 value-rep spine (M3→M4), #2660
fnctor-reconstruct, IR effect-model lane (#2134–#2141), async/Promise (#2613/#2614),
Proxy (#1355/#2618), standalone residual tails, type-oracle/pipeline refactors, and
the newly-unblocked substrate slices (#2710/#2722/#2724 for implementation in s67).

## Sprint 73 (2026-07-19 → 2026-07-21) — honest Test262 parity and external runner

**Baseline**: JS-host 28,294 / 43,106 (65.6%) → **30,282 / 43,099
(70.3%)**; standalone 27,378 / 43,106 (63.5%) → **28,136 / 43,106
(65.3%)**. 28 issues completed; 191 remain `sprint: current`.

The project runner and test262.fyi path now execute the original harness with
matching source assembly, fixture graphs, negative-test checks, async completion,
and verdict classification. The stricter oracle exposed silent false passes;
compiler and runner fixes converted the real supported cases back to passes.
`@loopdive/js2` gained the reusable `js2-test262` CLI for a first standalone-only
test262.fyi publication. Early IR/self-host/Porffor integration slices also
landed, while the architecture epics remain open.

The merge queue caught a 29-test illegal-cast regression in the JS-host closure
ABI before landing. It was fixed at the standalone `Reflect.construct` marker
boundary instead of being excused. Sprint bookkeeping drift was also repaired:
16 completed issues were normalized into sprint 73, and all unfinished work was
carried forward without retagging it to a numbered sprint.

### 2026-07-21 — v0.64.1 proxy metadata correction

Post-publish verification found that `js2wasm@0.64.0` still depended on
`@loopdive/js2@0.60.1`: the release script bumped the proxy package version but
not its dependency. #3516 repaired the release transaction, added a tag-publish
lockstep check, and superseded the immutable npm metadata with v0.64.1. The
published `js2wasm@0.64.1` proxy now depends exactly on
`@loopdive/js2@0.64.1`, and npm, JSR, and the GitHub release were verified.

## Sprint 74 (2026-07-21) — IR R0 truth boundary

IR retirement R0 is delivered. #3519 added typed terminal outcomes and an
honest `check:ir-only` policy gate; #3529 recovered the 154 compilation
failures that strict outcome handling exposed without expanding the equivalence
baseline. Full equivalence has zero new failures. One baseline-known case now
passes and remains deliberately unratcheted in this recovery slice.

The bounded hybrid lane is green with 31 / 37 IR-emitted units, six typed
Unsupported units, zero Invariants, and complete accounting. Strict remains
correctly non-green on the same six typed blockers and all 37 legacy-emitted
bodies. The broader #3518 program remains open: #3520 is the next ready R1
slice, and R2–R8 stay blocked behind it and their dependency chain.

The previous v0.64.1 patch is published and verified, including the matching
`js2wasm` proxy dependency on `@loopdive/js2@0.64.1`. PR #3483's advisory
merge-group differential then caught one lost boolean brand in
`closures/10-mutual.js`; PR #3486 retained the brand through IR and boxed it
with `__box_boolean`, restoring the 99 / 104 differential floor without a
baseline update. Sprint 74 closed at that corrected R0 boundary,
`a9b276c0eed97b2ce29b7ccaa29ebc5f4853e08d`, and the exact `sprint/74` tag is
published there. Authoritative merge-group Test262 run 29857062450 passed at
the same SHA: JS-host remained 30,282 / 43,099 and standalone improved by 13
passes to 28,149 / 43,106. The close harvest cross-referenced all >50-row
failure families and filed only one new Markdown owner: Backlog #3531 for 216
standalone array-concat/JS-array host-import leaks. v0.65.0 is cut from the
resulting `main` before execution pauses.

## 2026-07-21 21:41 — v0.65.0 published and verified

- Release PR #3488 merged to `main` at
  `14bdb88682b92ae2c081e19a2ef1bdf749e389c8` after CI, differential, and the
  full merge-group Test262 matrix passed. The annotated `v0.65.0` tag peels
  exactly to release commit `4ae9b1fd9b4c52fa7848c9ac011c3320748a6c8a`.
- Publish workflow
  [29862176875](https://github.com/loopdive/js2/actions/runs/29862176875)
  passed version verification and published `@loopdive/js2`, the `js2wasm`
  proxy, JSR, and the public GitHub release.
- Independent registry checks found both npm packages at `0.65.0` with the
  release commit as `gitHead`, the proxy dependency pinned exactly to
  `@loopdive/js2@0.65.0`, JSR latest at `0.65.0`, and a fresh
  `npx js2wasm@0.65.0 --version` returning `0.65.0`.
- No Test262 run logs or equivalence baselines were changed by the release.

## 2026-07-30 23:55 — sprint 77 frozen (late), de-inflation reflected, worktree-prune incident

- **Sprint 77 frozen with `--force`** at `88e12f2`: 79 issues re-tagged
  `sprint: current` → `sprint: 77`, 242 rolled forward, `plan/issues/sprints/77.md`
  written. Range `sprint-77/begin` (bb5b414, 2026-07-24) .. 2026-07-30 —
  1,541 commits, 671 merged PRs.
- **Frozen late, and the record says so.** No freeze ran at the budget rollover
  (the token-budget source is still unwired, #2751), so `freeze-sprint.mjs` was
  invoked after the fact. It re-tags by current frontmatter, not by date, so the
  window spans the intended tail *plus* the following days.
- **Host count fell 30,364 → 29,856 and that is the win, not a regression.**
  `ORACLE_VERSION` moved 10 → 12 inside the window (`69493a7`, the declared
  re-baseline for the #3603 host de-inflation). The oracle bump *is* the
  verdict-logic change, so both sides of the comparison classify rows
  differently — the counts are different quantities, not a delta. Standalone
  highwater 22,626 (official 22,394 / 43,106).
- **#3658 resolved.** The landing-page summary sync had frozen at
  `15:43Z / 30390-43098` while reporting SUCCESS five times; it is committing
  every few hours again (verified through 2026-07-30 20:44). The *hardening* —
  fail loudly when new baseline data yields no commit — is still open.
- **Incident: `git worktree prune` run from inside the container deleted the
  host session's live worktree registrations.** The repo is shared — the host
  sees it at `/Volumes/Archiv Mini/...` with worktrees under `/private/tmp/js2-*`,
  invisible from `/workspace`, therefore reported `prunable`. One `.git`, one
  registry. It caught active work (`js2-3836-repair` advanced
  `b96b016 → 0fc0989` between two commands). Committed work survived in the
  shared object store; registrations did not. Recovery is host-side
  `git worktree repair`. Rule recorded: `prunable` here means "not visible from
  where I'm standing", never "stale", and worktree cleanup is host-side work.
- `/workspace` was 1,279 commits behind and is now level with `origin/main`.
  The 13 dirty files reverted to get there were each verified: every local-only
  line already existed on `main` in evolved form. Nothing unique lost.

## Sprint 78 (2026-07-30 → 2026-08-18)

Rolling budget window frozen with `--force` on 2026-08-18. **293 issues
completed, 490 rolled forward**; nineteen days against sprint 77's 79 completed,
the largest window the rolling model has produced. Completed work concentrated
in the standalone/IR substrate (99 across `standalone-gap`, `standalone-mode`,
`ir-full-coverage`), then `es5` (32), `dogfood` (26), `performance` (23) and
`npm-library-support` (23).

**test262 at freeze: 32,615 / 43,621 (74.8%)** from
`benchmarks/results/test262-current.json` at `9896af5d7`. **No window delta is
recorded** — the wrap-up ran in a shallow clone (2026-08-15 → 2026-08-18) and
the start-of-window baseline is outside that history. The only movement visible
was 32,530 → 32,615 (+85) over the final four days.

- The freeze was **not** trigger-driven. `freeze-sprint.mjs` refused
  (`budget < 99%, > 1h left`) because the statusline's budget cache does not
  exist outside its host, so the remaining-budget reading was assumed, not
  measured. Closed on an explicit stakeholder call instead. Windows that end by
  judgement rather than by signal are hard to attribute numbers to — worth a
  time-based trigger alongside the budget one.
- **Nine issues carried statuses no tool recognises** (`complete` ×5,
  `in_progress` ×5, overlapping at #2929). `in_progress` is normalised by
  `build-data.js`; **`complete` is normalised by nothing**, and
  `freeze-sprint.mjs` matches `done` exactly — so five finished issues were set
  to roll forward as unfinished, silently, every window. Four were verified
  against their own named suites and promoted; #3764 was not.
- **#3764 stays `complete`, not `done`.** Its suite fails 2/3 on main: one
  environmental (test262 submodule uninitialised), one real — the
  standalone-purity assertion `importObject == {}` gets `env` plus a populated
  `string_constants`.
- **Every frozen window record read as open on the dashboard.** 75, 76 and 77 all
  had `isClosed=false`: `freeze-sprint.mjs` writes sprint docs with no
  frontmatter, so they fall to `build-data.js`'s
  `sprintNumber <= explicitlyClosedMax` fallback, and the last doc with a
  `status:` field was 74. Writing `status: closed` into the 78 doc raises the
  threshold and closes 75–77 too; the durable fix belongs in the freeze script.
- **Generated sprint issue-tables had drifted with nothing to heal them** —
  `sync-sprint-issue-tables.mjs` rewrote 16 docs (+752 lines; sprint 50 was
  missing #1406). No workflow calls it, unlike the test262 baseline or
  `npm-compat.json`, both of which catch up on the next merge.

Common thread across three of the five: **nothing validates frontmatter against
`SCHEMA.md`.** CI already walks every issue file for
`check:issue-ids:against-main`, so a status-enum check is nearly free — but the
schema needs reconciling first (it says `review`; practice and 17 live issues
say `in-review`, and `suspended` is unlisted).
