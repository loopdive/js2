---
sprint: 54
status: closed
created: 2026-05-21
planned: 2026-05-21
started: 2026-05-23
ended: 2026-05-23
baseline_pass: 28842
baseline_total: 43159
baseline_pct: 66.8
final_pass: 29239
final_total: 43159
final_pct: 67.7
begin_tag: sprint-54/begin
end_tag: sprint/54
authors: architect
wrap_checklist:
  status_closed: true
  retro_written: true
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: false
---

# Sprint 54 Plan — Decompose, dispatch, deliver

## Goal

**Harvest sprint 53's architect specs into merged PRs.** The previous sprint
was specification-heavy; sprint 54 turns those specs (async cluster, #779b
prototype-chain, #1556 dstr-param, IR-fallback decomposition, ECMAScript
spec-gap inventory) into code. Two parallel tracks run alongside:

1. **High-leverage spec-compliance wins** — close the #779b prototype-chain
   gap (~290 FAIL) and the #821 BindingElement null-guard regression (~537
   FAIL) that have been sized but un-merged for multiple sprints.
2. **Host-independence series** — finish the carried-forward #1471–#1474
   sequence so standalone (WASI) mode reaches feature parity with JS-host
   mode for the operations a typical compiled module needs.

## Expected pass-rate gain

Conservative addressable: **+1,400 tests** (+3.2% pass rate → 68.7%).
Optimistic addressable: **+2,300 tests** (+5.3% pass rate → 70.8%).

Per-issue estimates (conservative / optimistic), grouped by wave:

| Wave | Issue | Conservative FAIL→PASS | Optimistic |
|------|-------|------------------------|-----------|
| 1 | #779b Phase 1 (class instance prototype chain) | +230 | +290 |
| 1 | #821 BindingElement null-guard | +400 | +537 |
| 1 | #1522 Wasm type-coercion boundaries | +400 | +530 |
| 1 | #820c iterator result IsObject check | +30 | +39 |
| 1 | #820d async-gen method trampoline | +70 | +104 |
| 1 | #779c String.split result constructor | +60 | +78 |
| 1 | Easy spec batch A (#1570/#1574/#1575/#1572/#1573) | +25 | +50 |
| 2 | #1471 host-indep boxing/unboxing | strategic | +0 |
| 2 | #1116 Promise-API v2 (subset of WI1-WI8) | +80 | +150 |
| 2 | #1151 destructure-param null-guard (one-liner) | +6 | +20 |
| 2 | #1556 dstr-param struct-field type mismatch | +25 | +40 |
| 2 | #1529 illegal cast at closure/dstr boundaries | +100 | +200 |
| 2 | Easy spec batch B (#1568/#1578) | +40 | +90 |
| 3 | #1042 AST→IR async-cps.ts (Phase 2A) | +80 | +150 |
| 3 | #1576+#1580 descriptor defaults + ArraySpeciesCreate | +150 | +300 |
| 3 | #1577+#1589 Function.bind metadata + Date setters | +60 | +147 |
| 3 | #1130 Array accessor-observability | +60 | +120 |
| 3 | Easy spec batch C (#1564/#1565/#1566/#1567) | +30 | +50 |
| 3 | #1472 host-indep object/property ops | strategic | +0 |
| **Totals (waves 1-3)** | | **≈ +1,845** | **≈ +2,895** |

The headroom (waves 4+ stretch) is intentionally not baked into the goal.
S54 is a 3-wave sprint; wave 4 is stretch-only.

## Wave structure

Eight dev agents max. Waves are gated on PR-merge from the previous wave,
not on dev availability — devs roll into the next wave as their wave-N PR
merges. Within a wave, **assignments are by file-conflict cluster, not by
dev identity** (a "runtime owner" dev may finish two issues sequentially in
one wave; a "coercion owner" dev does the same).

### Wave 1 — Spec-compliance harvest (dispatch immediately)

8 issues, max 8 parallel devs. All have architect specs already in the
issue file or in `sprints/53/`. Conflict-free file partitioning:

| # | Issue | Title | FAIL | Files | Feas. | Effort | Spec? |
|---|-------|-------|------|-------|-------|--------|-------|
| 1 | **#779b** | class instance prototype chain (Phase 1) | 290 | `runtime.ts` (1207, 1386, 1500, 2575), `class-bodies.ts` (852, 969), `index.ts` (734) | medium | medium | ✅ in `sprints/53/779b-...md` |
| 2 | **#821** | BindingElement null-guard over-triggering | 537 | `destructuring-params.ts`, `closures.ts` (binding-pattern path) | medium | high | ✅ mature issue |
| 3 | **#1522** | Invalid Wasm at type-coercion boundaries | 530 | `type-coercion.ts` (extern/anyref ↔ struct call-sites) | medium | high | needs 0.5d arch — schedule wk-1 day-1 |
| 4 | **#820c** | iterator result IsObject check (yield* + for-of) | 39 | `expressions/calls.ts` yield*, `statements/loops.ts` for-of consumer | medium | high | ✅ G9 in #1563 |
| 5 | **#820d** | Async-gen method trampoline drops isAsyncGenerator | 104 | `closures.ts` trampoline emit | medium | medium | ✅ G24 in #1563 |
| 6 | **#779c** | String.split result Array.prototype identity | 78 | `array-methods.ts`, `string-ops.ts` | easy | low | ✅ G31 in #1563 |
| 7 | **#1564a** (batch) | Easy spec guards A: #1570 setProto cycle + #1574 typeof TDZ + #1575 in-primitive + #1572 ownKeys sort + #1573 spread eval order | 50 | `runtime.ts` (setPrototypeOf + ownKeys), `expressions/identifiers.ts` (typeof), `binary-ops.ts` (in), `expressions/calls.ts` (spread) | easy | low | ✅ G11/G14/G15/G16/G17 in #1563 |
| 8 | **#1461 carry** | Array.prototype.* arguments-shape mismatch (in-review from S53) | up to 948 | `array-methods.ts` | medium | medium | already in-review |

Wave 1 architect tasks (concurrent, do not block dev dispatch):
- Spec for **#1522** — pin the four call-sites; choose `coerceType` inline fix
  vs new helper. Owner: architect. ETA: 0.5d.
- Decomposition memo for **#820 residual** — what's left after #820a/b/c/d
  merge. Owner: senior dev. ETA: 1d (read-only investigation).
- Decomposition memo for **#779 residual** — what's left after #779b/c
  merge. Owner: senior dev. ETA: 1d.

### Wave 2 — Async-cluster foundation + host-indep + spec-gap batch B

8 parallel devs, dispatched as wave 1 PRs land. The async cluster
foundation (Phase 1 of the joint spec) runs here because it is
parallel-safe — the binding-pattern null-guard (#1151) is a one-line
override, the Promise-API completeness (#1116) is multi-file but
well-isolated from the state-machine work.

| # | Issue | Title | FAIL | Files | Feas. | Effort | Spec? |
|---|-------|-------|------|-------|-------|--------|-------|
| 1 | **#1151** | Async destructure-param null-guard (Phase 1A) | 20 | `closures.ts:875-886` (binding-pattern `wasmType` override) | medium | low | ✅ async-cluster spec §3 Phase 1A |
| 2 | **#1116** | Promise-API completeness v2 (WI1-WI8) | 150 | `expressions/calls.ts` (.then/.catch/.finally/`new Promise`), `runtime.ts` Promise host handlers, `statements.ts` (variable typing), `index.ts` (WI1 collect) | hard | max | ✅ v2 plan in issue body |
| 3 | **#1471** | Host-indep: boxing/unboxing in pure Wasm | strategic | `runtime.ts` boxing helpers | medium | high | ✅ existing spec |
| 4 | **#1522** | Wasm type-coercion boundary fix | 530 | `type-coercion.ts` | medium | high | spec from wave 1 day-1 |
| 5 | **#1556** | dstr-param struct-field type mismatch | 40 | `closures.ts` dstr-param flow; `destructuring-params.ts` | hard | max | ✅ spec-done in backlog/1556 |
| 6 | **#1529** | Illegal cast at closure & destructuring param boundaries | 200 | `closures.ts`, `destructuring-params.ts`, `type-coercion.ts` | medium | high | needs 0.5d arch (coordinate with #1556 spec) |
| 7 | **#1564b** (batch) | Easy spec guards B: #1568 Function.bind eager TypeError + #1578 apply/call non-callable | 90 | `expressions/calls.ts` (`.bind`, `.apply`, `.call` lowering) | easy | medium | ✅ G6/G27 in #1563 |
| 8 | **ESLint-new-1** | source-code.js anon `enter` closure captures externref into f64 global | strategic | `closures.ts` capture inference | medium | high | needs issue file + 0.25d arch |

Wave 2 architect tasks (concurrent):
- Spec for **#1042** Phase 2A — the new `src/codegen/async-cps.ts` module
  shape and AST → continuation-closure split. The async-cluster joint spec
  already defines the model; this task pins the API surface (`buildCps(ctx,
  fctx, body) → { prefix, continuations[] }`) before wave 3 dispatch.
  Owner: architect. ETA: 1d.
- Spec for **#1089** dynamic import — define interaction with #1326c
  microtask queue; clarify host-loader contract. Owner: architect. ETA:
  0.5d. Output unblocks wave 4 stretch.

### Wave 3 — Async state-machine + descriptor-default cluster + host-indep wave 2

8 parallel devs. By wave 3 we have:
- `#779b` Phase 1 has landed → wave 3 work on `_wrapForHost` is safe
- `#1556` has landed → `#1529` follow-ups can lean on its dstr-param shape
- `#async-cps.ts` spec (from wave 2) is ready → `#1042` can implement

| # | Issue | Title | FAIL | Files | Feas. | Effort |
|---|-------|-------|------|-------|-------|--------|
| 1 | **#1042** | AwaitExpression → async-cps.ts (legacy + IR routing) | 150 | NEW `src/codegen/async-cps.ts`, `expressions.ts:973`, `function-body.ts:567` | hard | max |
| 2 | **#1576** | Object.defineProperties: descriptor-default propagation | 150 | `runtime.ts:Object_create`, `Object_defineProperties` | medium | medium |
| 3 | **#1580** | Array.prototype.{map,filter,slice,concat} result %Array.prototype% | 150 | `array-methods.ts` (ArraySpeciesCreate threading) | medium | medium |
| 4 | **#1577** | Function.prototype.bind metadata (name, length) | 30 | `expressions/calls.ts:1248` post-bind metadata wiring | medium | medium |
| 5 | **#1589** | Date.prototype.set* returns new timestamp | 117 | `runtime.ts` Date proxy method bridging | easy | low |
| 6 | **#1130** | Array methods getter-observing property access (extend scope) | 120 | `array-methods.ts` (filter/every/some/forEach/reduce hot loops) | hard | high |
| 7 | **#1472** | Host-indep: object/property ops in pure Wasm | strategic | `runtime.ts` object-op helpers | medium | high |
| 8 | **#1564c** (batch) | Easy spec guards C: #1564 ToPrimitive Type check + #1565 ToBoolean BigInt + #1566 ToNumber Symbol throws + #1567 ToPropertyKey eval order | 50 | `type-coercion.ts` (sequential — single dev across all four) | easy/medium | medium |

Wave 3 architect tasks:
- Spec for **#1158+#1159** (destructure iterator semantics, bundled). Build
  on #1555 streaming-iterator. Owner: architect. ETA: 0.5d.
- Spec for **#1373b** Phase C lowering once #1326c Phase 1C-B has merged.
  Owner: architect. ETA: 0.5d. Output unblocks wave 4 if 1C-B is in.

### Wave 4 — Stretch (only if capacity opens mid-sprint)

Dispatched opportunistically when a dev's wave 1-3 PR merges and no
higher-priority task is queued. Order is by readiness, not priority:

| Order | Issue | Title | Why stretch |
|-------|-------|-------|-------------|
| 1 | **#1473** | Host-indep: error/exception ops | Pairs with #1536; sequential after #1472 |
| 2 | **#1474** | Host-indep: pure-Wasm RegExp | Final host-indep; sequential after #1473 |
| 3 | **#1373b** | IR async Phase C CPS lowering | Only if #1326c Phase 1C-B is merged AND #1042 has shipped `async-cps.ts` |
| 4 | **#1158+#1159** | destructureParamArray iterator semantics (bundled) | Needs wave 3 architect spec |
| 5 | **ESLint-new-3** | apply-disable-directives.js conditional-spread struct | Needs issue file + architect spec |
| 6 | **#1103** | Wasm-native Map/Set/WeakMap/WeakSet | Architect spec already exists; carve out Set first |
| 7 | **#1089** | Dynamic `import()` expressions | Needs wave 2 architect spec |
| 8 | **#1130 follow-up** | Accessor-observability on TypedArray | If #1130 lands early |
| 9 | **#983** | WasmGC objects leak to JS host as opaque values | Architect spec required; gate behind #779b |
| 10 | **#1536** | Wasm-native exception types ($Error WasmGC struct + try_table) | Pairs with #1473 |
| 11 | **#1584** | Iterator.prototype helpers brand check | Gate behind #779b (shares proxy layer) |
| 12 | **#1105** | Wasm-native String methods | Architect spec exists; large surface |
| 13 | **#1582** | RegExp Symbol.{match,search,split,matchAll} residual | After #820a baseline observed |

## Conflict risk analysis

The following file pairs are touched by multiple issues in the same wave
and must be sequenced via single-dev ownership:

| File | Owners (in wave order) | Mitigation |
|------|------------------------|------------|
| `src/runtime.ts` | W1: #779b (lines 1207/1386/1500/2575), #1564a (setPrototypeOf, ownKeys) | Two distinct regions — but assign **one "runtime owner" dev** to both to serialise commits |
| `src/runtime.ts` | W2: #1471 (host-indep boxing) | Assign to same runtime owner as W1, sequential |
| `src/runtime.ts` | W3: #1472 + #1576 + #1589 (Date setters, Object_create) | Same runtime owner; sequence #1472 → #1576 → #1589 |
| `src/codegen/type-coercion.ts` | W1: #1522 spec gate | Hold dev 4's #1522 implementation start until W1 day-2 (after spec) |
| `src/codegen/type-coercion.ts` | W2: #1522 implementation | Single "coercion owner" dev — no parallel work |
| `src/codegen/type-coercion.ts` | W3: #1564c batch (#1564/#1565/#1566/#1567) | Same coercion owner; sequential after #1522 merges |
| `src/codegen/closures.ts` | W1: #820d (trampoline) | Different region from #1151 |
| `src/codegen/closures.ts` | W2: #1151 (binding-pattern wasmType override) + #1556 + #1529 + ESLint-new-1 | Sequence as #1151 (one-liner, lands first) → #1556 → #1529 → ESLint-new-1 |
| `src/codegen/array-methods.ts` | W1: #779c + #1461-carry | Different methods — #779c touches split, #1461 touches filter/map/every. Parallel-safe |
| `src/codegen/array-methods.ts` | W3: #1580 + #1130 (extension) | Both touch ArraySpeciesCreate / accessor-observability — assign to single dev (the "array owner") |
| `src/codegen/expressions/calls.ts` | W2: #1116 + #1564b | #1116 WI3 (receiver type-guard) and #1564b (.bind/.call/.apply guards) edit the same call-dispatch region — **sequence #1116 WI3 FIRST (it's surgical), then #1564b** |
| `src/codegen/expressions/calls.ts` | W3: #1577 (.bind metadata) | After W2 — same "calls owner" dev |
| `src/codegen/expressions.ts:973` (AwaitExpression) | W3: #1042 | No conflict; legacy is a one-line no-op until W3 |
| `src/codegen/class-bodies.ts` | W1: #779b only | No co-occupancy |
| `src/codegen/destructuring-params.ts` | W1: #821 + W2: #1556 + #1529 | Critical hot-file — **#821 lands first in W1, then #1556 + #1529 sequence in W2** |
| `src/codegen/statements.ts` / `statements/loops.ts` | W1: #820c, W2: #1116 (variable typing WI5) | Different sub-files (loops.ts vs statements.ts) — parallel-safe |
| `src/codegen/index.ts` | W1: #779b (`sourceContainsClass` block), W2: #1116 (WI1 import collect) | Different blocks — verify by spec; otherwise sequence |
| `src/runtime-eval.ts` | W3 stretch only — no W1/W2 work |

**Refactoring issues #804 and #806 from PO's note**: not on the W1-W3 list.
They are EXPLICITLY DEFERRED to S55+ — both touch `expressions.ts` broadly
and would conflict with #1042's `AwaitExpression` rewrite. If a senior dev
slot opens late in S54, prefer #983 over #804/#806.

## Issues NOT included (deferred to sprint 55+)

| # | Title | Reason for deferral |
|---|-------|---------------------|
| #1089 | Dynamic `import()` expressions | Needs architect spec for #1326c microtask interaction; spec scheduled W2 but implementation is W4 stretch only |
| #1103 | Wasm-native Map/Set/WeakMap/WeakSet | Large surface (~98 fails) — pair with #1474 in a dedicated "wasm-native runtime" sprint |
| #1105 | Wasm-native String methods | Same reasoning as #1103 — split out into its own sprint |
| #1373b | IR async Phase C CPS | Blocked on #1326c Phase 1C-B — only viable as W4 stretch if 1C-B lands during the sprint |
| #1158+#1159 | destructureParamArray iterator semantics | W4 stretch; spec scheduled W3 |
| #983 | WasmGC objects leak to JS host | Architect spec needed; gate behind #779b — W4 stretch at earliest |
| #1536 | Wasm-native exception types ($Error struct) | Pairs with #1473 — W4 stretch only |
| #1584 | Iterator.prototype helper brand checks | Hard (~178 FAIL) but interacts with #779b proxy layer; defer until W3 ships |
| #1582 | RegExp Symbol.{match,search,split,matchAll} residual | Defer until #820a finishes and we have a clean baseline |
| #804 / #806 | Refactor expressions.ts | Conflicts with #1042's `AwaitExpression` rewrite — defer to S55 |
| Stretch from candidates table (#1130 escalation, #1252, #1253, #1383) | Already done / partly done / in-review | Backlog hygiene only — confirm `status: done` and remove from open lists |

## Open questions / pre-sprint TODOs

These must be resolved before sprint kickoff (TL/PO collaboration):

1. **PR #408 status** — the host-indep series (#1471–#1474) was originally
   blocked on PR #408. Verify merge status before W2 dispatch. If unmerged,
   #1471 in W2 is at risk; TL to resolve on day 1.
2. **Sprint 53 close-out audit** — confirm `#820a`, `#820b` final status.
   #820b is `status: in-progress` in `sprints/53/`; if not merged by W1
   open, fold the remaining work into W1 issue #4 (#820c) or carry the
   in-progress branch over.
3. **Architect bandwidth** — five W1+W2 architect specs queued:
   - #1522 (0.5d, W1 day-1)
   - #820 residual decomp (1d, W1)
   - #779 residual decomp (1d, W1)
   - #1042 async-cps.ts API (1d, W2)
   - #1529 + ESLint-new-1 (0.5d combined, W2)
   - #1089 (0.5d, W2)
   - #1158+#1159 + #1373b (0.5d each, W3)
   
   Total architect days: ~5.5. With one architect, **batch the four smaller
   W1/W2 specs into a single 1-day session** to free up time for #1042 and
   #820/#779 decomp.
4. **Backlog hygiene** (per candidates §"Backlog hygiene at planning"):
   - Flip `#1129` to `done` in backlog/ copy
   - Move `#1471-#1474` into `sprints/54/` (currently in `sprints/52/`)
   - Confirm `#1252`, `#1253`, `#1134` `status: done`
   - Audit `#1373` / `#1373b` / `#1326c` / `#1352`
5. **ESLint-new issues file** — PO to file two issues from
   `eslint-next-layer-survey.md` before W1 (ESLint-new-1) and W2 dispatch.
6. **Senior dev (Opus) slot** — #820 and #779 residual decomposition
   each need one full day of senior-dev attention. Confirm Opus
   availability for W1.

## Architect coverage matrix

For each issue in the plan, this records whether an implementation spec is
already in the issue file, in a sibling file under `sprints/53/`, or still
to-be-written:

| Issue | Spec location | Status |
|-------|---------------|--------|
| #779b | `sprints/53/779b-class-elements-multi-definition-parsing.md` §"Implementation Plan" | ✅ Ready |
| #821 | `backlog/821-...md` | ⚠️ Mature ticket, no formal arch spec — leverage 779b dev investigation pattern |
| #820c | #1563 G9 + existing 820c file | ✅ Ready |
| #820d | #1563 G24 + existing 820d file | ✅ Ready |
| #779c | #1563 G31 + existing 779c file | ✅ Ready |
| #1522 | needs spec — **W1 day-1 architect task** | ⏳ Pending |
| #1564a/b/c batches | #1563 G1-G3 + G6/G11/G14-G17/G27 (inventoried) | ✅ Ready |
| #1461 | already in-review from S53 | ✅ Ready |
| #1151 | async-cluster spec §3 Phase 1A (one-line override) | ✅ Ready |
| #1116 | issue body §"v2 plan WI1-WI8" | ✅ Ready |
| #1471, #1472 | sprints/52/1471, sprints/52/1472 | ✅ Ready |
| #1556 | backlog/1556 §"Implementation Plan" | ✅ Ready (spec-done) |
| #1529 | needs spec — **W2 architect task** (coordinate with #1556) | ⏳ Pending |
| #1042 | async-cluster spec §2-§3 — `async-cps.ts` module shape needs to be pinned in **W2 architect task** | 🟡 Half-ready |
| #1576, #1577, #1580, #1589 | #1563 G25, G26/G27, G30, G46 | ✅ Ready (small) |
| #1130 | issue body + #1563 G7 | ✅ Ready |
| ESLint-new-1 | survey doc; needs issue + 0.25d spec | ⏳ Pending |
| ESLint-new-3 | survey doc; needs issue + 0.5d spec | ⏳ Pending |

## Sprint Definition of Done

- [ ] All W1 issues merged or moved to W2 with a documented blocker
- [ ] #779b Phase 1 merged — `assert.sameValue(c.m, C.prototype.m)` passes on
      a representative test262 sample (target: ≥230 of 290 sub-cluster)
- [ ] Host-indep series: #1471 merged; #1472 merged or carried into S55 with
      explicit ownership note
- [ ] Async cluster Phase 1A (#1151) merged; #1116 v2 at least WI1-WI4
      merged; #1042 `async-cps.ts` module skeleton landed (full Phase 2A
      acceptable in S55)
- [ ] Net test262 pass-rate up by **≥+1,400** vs S54 baseline
- [ ] No new compile-error regression cluster larger than 50
- [ ] No closed S53 issue regresses (`dev-self-merge` baseline-validation
      sample must still pass)
- [ ] Architect spec files for #1522, #1042 async-cps API, and #1089
      written into respective issue files
- [ ] `plan/log/dependency-graph.md` updated for every merged issue

---

*Drafted by architect, 2026-05-21. Inputs: `sprints/54/sprint-candidates.md`
(PO po-s54), `backlog/1563-...md` (architect spec-gap inventory),
`sprints/53/async-cluster-architect-spec.md`, `sprints/53/779b-...md`,
`sprints/53/ir-fallback-analysis-2026-05-21.md`, `plan/log/dependency-graph.md`.*

---

## Closeout (2026-05-23 — compressed retroactive cycle)

Sprint 54 effectively ran as a single-day compressed cycle on 2026-05-23,
directly after sprint 53 closed at PR #408 (commit `de610f41d`,
11:12Z). The 3-wave structure described above was not enforced —
work instead flowed as a wide opportunistic merge wave (~25 PRs)
covering CI infrastructure, conflict resolution, a single regression
revert, planning, and a handful of issue PRs that landed alongside the
infra work.

### Test262 movement

| Metric | Start (sprint-54/begin) | End (sprint/54) | Delta |
|--------|------------------------:|----------------:|------:|
| pass   | 28,842 | 29,239 | **+397** |
| total  | 43,159 | 43,159 | 0 |
| pct    | 66.8%  | 67.7%  | +0.9 pp |

(Baselines: start = sharded baseline at sprint 53 close; end = latest
sharded baseline after today's merge wave. Net is +397 after one
regression revert mid-cycle — see `#440 / #516` below.)

### Total issues / done / deferred

- **Total in plan**: 24 issues across waves 1–3 (W4 stretch unscheduled).
- **Sprint 54 issue files at close (after #521)**: 3 — #1583, #1589, #1589A.
- **Done in sprint 54**: 2 — #1583 (via PR #489), #1589 (via PR #509).
- **Moved to sprint 55**: 1 directly from sprint 54 (#1589A — Hot Spot A
  needs real fix); 4 transitively from sprint 53 carry-over (#1553b,
  #1553c, #1553d, #820d); 4 from sprint 52 (#1471–#1474 host-indep);
  2 from backlog (#1130, #1116). Total moved: **11** issue files.
- **Marked done in sprint 53 by this closeout**: #1580 (PR #482 merged on
  2026-05-22; previously stale `ready` status).
- **Deferred from the W1–W3 plan**: ~16 issues (the structured
  spec-compliance harvest was not attempted as scheduled).

### Key landed PRs (merged on `main` between sprint-54/begin and sprint/54)

**Issue PRs (compiler / spec-completeness):**
- #415 issue-1531 JSX parsing
- #416 issue-1526 BigInt-Promise TypeErrors
- #429 issue-1540 JSX runtime
- #433 issue-1550 dstr init skipped
- #434 issue-1552 catch dstr
- #437 issue-846 class static prototype
- #438 issue-1551 super-call eval
- #436 issue-1116 promise resolution
- #443 issue-1543/1544 (path B)
- #454 issue-1553e decl-dstr (carry from S53)
- #457 issue-1559 resolver bare-package import
- #441 issue-1373b IR async CPS
- #474 issue-106 default standard pass rate
- #483 issue-1525 branch protection v2
- #391 issue-1480 WASI console stderr

**Regression revert:**
- #440 issue-1542 class-dstr-default — landed a -1,219 test262 regression
- #516 revert — backed #440 out within ~90 min once the regression bucket
  was identified

**CI infrastructure (the dominant work category today):**
- #503 bump shards from 50 to 115
- #505 slow-lane shard (sort shard test list by descending duration)
- #485 fix local 16-shards
- #491 promote-baseline writes only to js2wasm-baselines repo
- #492 disable failing push-to-main steps in 4 workflows
- #493 revert workflow repo-check back to loopdive/js2
- #494 docs+scripts repo refs updated to loopdive/js2
- #495 re-enable auto-refresh-prs.yml on push:main
- #496 skip test262 on github-actions[bot] synchronize
- #497 fix(#496) restore gate firing on bot synchronize
- #499 disable auto-refresh-prs push trigger
- #506 (auto-retry / staleness adjacent — landed in cluster)
- #511 per-ref CI concurrency + auto-retry on compile_timeout
- #513/#514/#517/#518/#519/#520 — auxiliary CI flag/policy chasing
- #482 issue-1580 string-hash perf (CI side)

**Planning & scope:**
- #498 issue-1584 Wasm-GC-native bytecode interpreter strategy doc
- #500 sprint 55 planning worktree (added issues #1586/#1587/#1588 to s55)
- #501 (planning artifact)
- #507 (planning artifact)
- #1589A hot-spot diagnosis + skips (post-#440 triage)
- #521 close sprint 53, move 5 issues to sprint 54 (the prerequisite PR
  for this closeout — in the merge queue at the time sprint 54 closed)

**Agent-driven conflict resolution wave (13 PRs in parallel):**
- #502 conflict resolve 502
- #509 conflict resolve 509
- #408 issue-1470 no-js-host-string-ops (sprint 53 cap PR)
- #404 issue-1504 browser-export-interop
- #403 conflict resolve 403
- #379 conflict resolve 379
- #392 conflict resolve 392
- #394 conflict resolve 394
- #395 conflict resolve 395
- #396 conflict resolve 396
- #397 conflict resolve 397
- #398 conflict resolve 398
- #430 conflict resolve 430
- #425 conflict resolve 425
- #428 conflict resolve 428
- #419 conflict resolve 419

### Notes on what wasn't done

The W1–W3 plan above was largely _not executed_ as designed. The cycle
was dominated by CI infra and conflict resolution rather than the
spec-compliance harvest. Specifically:

- #779b Phase 1 — not landed this cycle (carry to S55)
- #821 BindingElement null-guard — not landed
- #1522 type-coercion boundaries — not landed
- #1471/#1472 host-indep series — not landed
- #1042 async-cps.ts skeleton — not landed
- All easy spec batches (A/B/C) — not landed

The +397 test262 delta came from the issue PRs listed above plus the
incidental fixes inside the conflict-resolution wave. The retro
(`plan/log/retrospectives/sprint-54.md`) discusses why the structured
wave plan did not materialise and what S55 should do differently.

### Tag handling

- `sprint-54/begin` is created locally at `de610f41d` (PR #408 merge,
  sprint 53 close); **not pushed** — tech lead to push.
- `sprint/54` is created locally at HEAD; **not pushed** — tech lead to
  push.
- Sprint 53 also has its end-tag local-only (`sprint/53`); the begin
  tag for s53 was never created (noted in s53 retro).

### Issue moves performed by this closeout PR

The following files were moved + frontmatter updated by this PR. If PR
#521 (sprint 53 close) lands first, the s53→s55 rename pairs may
conflict on disk — tech lead to resolve in favor of the
`sprints/55/` destination (this PR's intent).

| File | From | To | Frontmatter change |
|------|------|------|--------------------|
| `1589A-object-literal-field-type-and-has-idx.md` | `sprints/54/` | `sprints/55/` | sprint: 54 → 55 |
| `1553b.md` | `sprints/53/` (PR #521 moves to `sprints/54/`) | `sprints/55/` | sprint: 53 → 55 |
| `1553c.md` | `sprints/53/` (PR #521 moves to `sprints/54/`) | `sprints/55/` | sprint: 53 → 55 |
| `1553d.md` | `sprints/53/` (PR #521 moves to `sprints/54/`) | `sprints/55/` | sprint: 53 → 55 |
| `820d-async-gen-meth-unresolvable-cast.md` | `sprints/53/` (PR #521 moves to `sprints/54/`) | `sprints/55/` | sprint: 53 → 55 |
| `1471-no-js-host-boxing-unboxing.md` | `sprints/52/` | `sprints/55/` | sprint: 52 → 55 |
| `1472-no-js-host-object-property-ops.md` | `sprints/52/` | `sprints/55/` | sprint: 52 → 55 |
| `1473-no-js-host-error-exceptions.md` | `sprints/52/` | `sprints/55/` | sprint: 52 → 55 |
| `1474-no-js-host-regex-standalone.md` | `sprints/52/` | `sprints/55/` | sprint: 52 → 55 |
| `1130-array-methods-getter-observing-property.md` | `backlog/` | `sprints/55/` | add sprint: 55 |
| `1116-promise-resolution-and-async-error.md` | `backlog/` | `sprints/55/` | add sprint: 55 |

Status-only updates (no move):

| File | Status change | Reason |
|------|---------------|--------|
| `sprints/54/1583-landing-feature-support-table-audit.md` | in-progress → done | PR #489 merged 2026-05-23 |
| `sprints/54/1589-test262-compile-timeout-bucket-100-tests.md` | ready → done | PR #509 merged 2026-05-23 |
| `sprints/54/1580-string-hash-benchmark-...md` | ready → done | PR #482 merged 2026-05-22 (was stale; PR #521 had already moved the file from s53 to s54 before this PR landed) |

#1580's PR landed before sprint 53 even closed; the file's status was
just never updated. This closeout sweeps it back to `done` so it doesn't
linger as fake-open work into sprint 55.
