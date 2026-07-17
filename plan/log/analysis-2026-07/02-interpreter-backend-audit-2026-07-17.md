# 02 — Interpreter-backend audit (Tier 2 of the eval ladder), 2026-07-17

> Audit of the standalone bytecode interpreter ("Tier 2" of the
> `eval`/`new Function` runtime-code-evaluation ladder) against
> `origin/main @ d558684f09` (2026-07-17). Authoritative design:
> `docs/architecture/runtime-eval-interpreter.md` (Part II §12–§16 wins).
> Companion to `00-ir-async-standalone-audit.md` (2026-07-02, §4 covered this
> area). Written under a hard budget cutoff — sections marked **[NOT YET
> INVESTIGATED]** are honest stubs, not omissions by oversight.

---

## 0. Headline status (verified, with sources)

| Tier | Mechanism | Status on main 2026-07-17 | Evidence |
|---|---|---|---|
| 0 — compile-away | AOT splice, `eval("<const>")` + `new Function("<const>")` | **Landed and further broadened since the doc**: #2923, #2924 done (sprint 69); **#1102 done** (`sprint: current`, merged PR #3113 `63de25b6e751`) widened the constant detector to `const`-bound strings/templates | `src/codegen/expressions/eval-inline.ts` (1,233 lines; `tryStaticNewFunction` :720, `synthesizeStaticNewFunction` :748); residual bail tracked as #3301 (ready, Backlog) |
| 1 — JS-host meta-circular | `createEvalShim` / `createNewFunctionShim` | **Landed**; two known gaps still open: #2925 (direct-eval scope reification, `status: backlog`) and #3017 gap 2 (free-var `ReferenceError` shape / eval-code linkage, `status: ready`, Backlog) | `src/runtime-eval.ts` (531 lines) |
| **2 — standalone bytecode interpreter** | self-compiled Acorn → bytecode → dispatch loop | **NOT BUILT — zero implementation.** No `src/interp/` directory exists; no opcode ADR in `docs/adr/` (highest is `0018-structured-ir-nested-buffers.md`). The only bytecode code on main is the **#1715 proof point**: `src/ir/backend/bytecode-emitter.ts` (745 lines) + `bytecode-vm.ts` (548 lines) — a *stack* machine over the *numeric* subset, untouched by feature work since 2026-05-30 (recent commits to those files are #2953 emitter-routing refactors only) | `ls src/`, `ls docs/adr/`, `git log -- src/ir/backend/bytecode-*.ts` |
| 3 — refuse loudly | compile warning + catchable call-time throw | **Landed** (#2960 done, sprint 69) | `src/codegen/expressions/calls.ts` refuse-loud path (~:539, :620), `new-super.ts` |

**The most important finding is NOT that Tier 2 is unbuilt (expected — it was
gated). It is that the gates in front of its first slices have now cleared,
and nothing in the live queue reflects that:**

- **P1/P2 (the #2853-A/B compiled-acorn parser blockers) are DONE** — #2853
  `status: done, sprint: 71` (2026-07-13), and #2850 (regex char-class /
  named-group half) also `done, sprint: 71`. These were named in doc §15 as
  "the hard blockers left before #2928 can wire the parser."
- **Compiled Acorn is now at FULL corpus parity** — re-ran the #1710 dogfood
  harness during this audit (2026-07-17, `pnpm run dogfood:acorn-corpus`):
  `inputs=23 equal±quirks=23 REAL=0 compiled-threw=0 oracle-error=0`. That
  is up from `13/22 equal, REAL=8, threw=1` at the last recorded run
  (2026-06-30) — `regex.js` no longer throws, and zero REAL divergences
  remain. `tests/dogfood/CORPUS-GAP-MAP.md` is stale and needs its header
  refreshed with this result (see §4).
- **E1 (the interpreter library, Node-tested, zero Wasm/substrate risk) has
  been fully unblocked since 2026-07-09 and is pre-specced to
  "implement-don't-decide" depth by #3101** (`3101-bytecode-isa-frame-abi-prespec.md`:
  complete 34-op register+accumulator ISA, i32 packed encoding, `$FuncMeta`/
  `$Frame`/`$EnvRec` WasmGC layouts, side exception-table design, the
  `__interp_enter` AOT↔interp trampoline contract). #3101 has
  `depends_on: []` — yet sat at `sprint: Backlog`, invisible to the TaskList
  sync. **Promoted to `sprint: current` by this audit.**
- **E0 (#3308, in-Wasm AST consumer probe, S)** is `ready, sprint: current` —
  correctly queued.
- Of the E5 `CallBuiltin` prerequisite gap slices: **G1 (#3309) done**
  (merged PR #3143), **G3 (#3098 + #3235 residual) done**; G2 (#3310) and
  G4 (#3311) `ready, sprint: current`.

So per #2928's own milestone order — E0 → (P1 ∥ P2 ∥ E1) → E2 — the entire
pre-E2 frontier is either done (P1/P2, parser parity) or startable today
(E0, E1), and E2 (the self-compile, the risk concentration) is the only
remaining step before standalone `new Function(<dynamic>)` works. **Tier 2 is
newly startable.**

## 1. Finding — Tier 2 implementation inventory: design-complete, code-zero

Verified by search (`grep -ril bytecode src/`, `ls src/interp src/interpreter
runtime`): the only interpreter-adjacent code is

- `src/ir/backend/bytecode-emitter.ts` + `bytecode-vm.ts` — the #1715
  proof (stack machine, `OP.CONST..RET` numeric subset, host-TS +
  compiled-through-js2wasm VM equivalence tests). Real, useful as the
  "js2wasm compiles a dispatch loop well" proof, but **not** the Phase-1
  interpreter: wrong encoding (stack vs the ADR'd reg+acc), wrong producer
  (IR, not ESTree), numeric-only values (no boxed-any).
- `src/codegen/regex/{bytecode,vm}.ts` — the unrelated dual-RegExp-backend
  VM (#682). Not part of this ladder (but an existence proof that a
  self-hosted bytecode VM pattern already ships in production).

Design artifacts, by contrast, are complete and current: the arch doc Part II
(ADR §13 bytecode-over-tree-walking; §14 unified `$EnvRec` name resolution;
§16 slice sequence), #2928's `## Implementation Plan` (2026-07-04), and #3101
(2026-07-09, the ISA pre-spec). Tier 2 is a **shovel-ready** XL, not a
research problem.

## 2. Finding — substrate gates: mostly cleared or not actually load-bearing for E1–E5

| Gate (per doc §1/§8) | Current state | Actually blocks |
|---|---|---|
| #2853-A/B parser bugs | **done** (sprint 71); corpus re-run 2026-07-17 confirms 23/23 parity, 0 REAL | nothing — cleared |
| #2937 `$Object`-hash poison | **done** (sprint 69) | nothing — cleared |
| self-host maturity (#1058/#1710) | #1710 done; Acorn compiles 100% + binary validates 100% + full corpus parity (above); self-host track has real momentum (#3256 done, #3257 measured-and-closed, `plan/self-hosting-scale-up.md`) | E2's self-compile inherits residual gaps — surfaced as child issues by design, not a start-blocker |
| #2864 `$Frame` (generator carrier) | `in-progress` (F1/F1b/F2 landed, carrier-completion R1 in PR per issue file) | only **#2929/F** (direct eval, generators-in-eval). #3101 explicitly requires only *coordination on `$Frame` field order* before freezing, not landing #2864 |
| #2527 core-wasm linking | `in-progress` (sprint 67; Phase-2 follow-ons P2a-c open per issue tail) | only **E6 (packaging)**. Doc §3.2(b) already reclassified #2527 as a *distribution optimization*; 00-audit §4 said "do NOT block eval slices on it" |
| boxed-any substrate maturity | actively hardening (#2040 A1 default-on classifier landed `46be13726d`; #3053 dyn-member-get landed) | E2+ inherit it; E1 (Node-tested) does not touch it |

Conclusion: **E0 + E1 have zero unmet dependencies; E2's dependencies are
P1/P2 (done) + E0 + E1.** The doc's framing "built last, gated on independent
substrate work" is now stale as a reason for inaction on E1.

## 3. Finding — stale planning artifacts under the #1584 umbrella

1. **#1584's embedded `## Parallel slice plan + bytecode contract`
   (2026-05-30) is superseded but not marked.** It commits to the
   IR→bytecode producer as Phase 1 ("the 166-site trait migration … is the
   load-bearing bulk of #1584", slices a0–a6/b/c/d, stack-encoding staging
   note, `src/runtime/eval-entry.ts` + `estree-to-ir.ts` file plan). Part II
   §12.1 explicitly resolves this the other way: **Phase 1 builds only
   producer (a), the runtime ESTree→bytecode emitter; the IR producer is a
   Phase-3 option re-decided at #2929 time**, and E1's file plan is
   `src/interp/` (per #2928/#3101). A dev opening #1584 today could burn an
   XL on the wrong (superseded) plan. **Supersession banner added by this
   audit.**
2. **`plan/issues/backlog/1447-adr-013-interpreter-bytecode-design.md`
   (2026-05-20) is a live duplicate of the now-answered ISA question** —
   priority `high`, status `backlog`, asking exactly what doc §13 + #3101
   decided (reg+acc, br_table dispatch). Also: it names the ADR "ADR-013",
   but `docs/adr/0013` is already `ir-allocation-sites`; #3101 correctly
   targets `0019`. #1447 should be closed as superseded (or folded into
   #3101). It also lives in the legacy `plan/issues/backlog/` directory
   rather than flat (#1616 scheme). **Flagged for PO — not closed here.**
3. **#2927 metadata is stale relative to its own body.** Frontmatter
   `depends_on: [1058, 1710, 2527]`: #1710 is done; #2527 gates only the
   optional-linking acceptance line (E6-shaped), not the remaining Part-1
   work; #1058 is an umbrella that never flips done. Meanwhile the issue's
   own 2026-07-16 slice-decomposition table shows its real remaining scope
   is #3308/#3310/#3311 + the parser-artifact/packaging half. #2927 is
   `ready, sprint: current` and self-describes as "claim one named slice,
   not the whole umbrella" — it is effectively a tracking shell now; its
   depends_on should be corrected so dependency dashboards don't show it
   blocked on a done issue. **Flagged for PO.**
4. **#2928 `depends_on: [2927, 2853]`** — #2853 is done; recorded in the
   issue by this audit (frontmatter left for PO reconciliation).
5. **Goal file `plan/goals/runtime-eval.md` roadmap table** still lists
   #2923/#2924 as `current` (they're done, sprint 69) and doesn't mention
   the E0/P/G/E1–E6 decomposition or #3101 at all; its autogen issue table
   lists only #1584. **Flagged for PO.**

## 4. Finding — compiled-acorn fidelity: measured clean 2026-07-17; gap map stale

`tests/dogfood/CORPUS-GAP-MAP.md` header still shows the **2026-06-30** run
(`inputs=22 equal±quirks=13 REAL=8 compiled-threw=1`, `regex.js` the sole
thrower). Since then #2937, #2853-A/B, #2850, #2841, #2851, #2852, #2846 all
landed. This audit re-ran the harness (2026-07-17, worktree at
`origin/main d558684f09`):

```
inputs=23  equal=0  equal±quirks=23  REAL=0  compiled-threw=0  oracle-error=0
```

**Full structural parity, zero REAL divergences, zero throws.** The doc §15
"two tokenizer/validator bugs are the hard blockers" is fully resolved; the
suspected-marshalling issues (#2841/#2851/#2852) no longer even show as
divergences at the host boundary, which also lowers E0's stakes (E0 remains
worth doing as the in-Wasm read-path fidelity metric for the emitter).
Action: refresh `CORPUS-GAP-MAP.md`'s header with this run (left to the E0
owner — the map is a generated-artifact doc owned by the dogfood harness
flow, and this audit branch avoids touching test-owned docs).

## 5. Finding — current test262 eval-bucket numbers (measured from the live baseline)

From `test262-current.jsonl` (baselines repo, fetched 2026-07-17; baseline
sha `a5dbaa11d5`, oracle_version 6):

| Bucket | pass | fail | CE | total | doc §5.2 (2026-07) said |
|---|---|---|---|---|---|
| `built-ins/eval` | 6 | 4 | 0 | 10 | 7 / 3 |
| `language/eval-code/direct` | **57** | 228 | 1 | 286 | 209 / 76 |
| `language/eval-code/indirect` | 31 | 29 | 1 | 61 | 31 / 30 |
| `built-ins/Function` (all) | 274 | 234 | 1 | 509 | 252 / 254 |

Function-ctor +22 and indirect flat are plausible (#2924/#2960/#1102).
**The direct-eval drop (209 → 57 pass) is a red flag** — but oracle_version
has been bumped repeatedly since the doc's measurement (verdict-logic
changes, e.g. #3285/#3189 uncatchable-trap/floor ratchets), so this may be
reclassification rather than regression. **[NOT YET INVESTIGATED — needs a
`/analyze-regression`-style diff of the direct-eval bucket between a
pre-oracle-6 baseline and current; do NOT treat as a confirmed −150
regression, but do not ignore it either.]** Overall: host pass 32,671/43,106;
standalone honest floor 24,946 (`test262-standalone-highwater.json`) — the
floor is up from the 00-audit's 18,157 (2026-07-02), so doc §5.3's
"standalone cliff" framing understates current standalone maturity while
remaining correct that dynamic-code tests are ~0 standalone.

## 6. Recommendations (dependency-ordered)

1. **Promote #3101 (E1: `src/interp/` library + ADR-0019) into the live
   queue** — L, zero merge-conflict surface (new directory), zero substrate
   risk, spec-complete. This is the actual start of Tier 2. **Done in this
   audit's commit** (`sprint: Backlog → current`).
2. Keep #3308 (E0, S) queued; fold the CORPUS-GAP-MAP refresh into it (§4).
3. After E0+E1: dispatch **E2** (self-compile + standalone dynamic
   `new Function`) per #2928's plan — the risk-concentration slice; its
   named prerequisites are then all met. G2 (#3310) should land before/with
   E5.
4. Hygiene: #1584 supersession banner (done here); PO to reconcile #2927
   depends_on, close-or-fold #1447, refresh the runtime-eval goal roadmap
   table.
5. Follow-ups **[NOT DONE — budget]**: direct-eval bucket diff (§5);
   re-measure `scripts/eval-const-classifier.mjs` post-#1102; verify
   #2925/#3017-g2 remain accurate against `runtime-eval.ts` HEAD
   (spot-checked exports only); deeper code-quality pass over
   `eval-inline.ts` (1,233 lines) and the Tier-3 routing in `calls.ts`
   (not audited line-by-line).

## 7. Issues created/updated by this audit

- **Updated #3101** — `sprint: Backlog → current` (the headline unblock).
- **Updated #2928** — recorded #2853 done + audit pointer.
- **Updated #1584** — supersession banner on the 2026-05-30 slice plan.
- **Flagged for PO (no file change): #1447** close-as-superseded by #3101;
  **#2927** depends_on correction; runtime-eval goal roadmap refresh;
  CORPUS-GAP-MAP header refresh (fold into #3308).
- No new issue ids allocated: every actionable gap found already has a
  tracking issue (#3308/#3310/#3311/#3301/#2925/#3017/#2928/#2929/#3101) —
  the gap was *queue visibility*, not missing issues. The one candidate new
  issue (direct-eval bucket triage, §5) is deferred pending the
  oracle-version disambiguation; file it only if the diff shows a real
  regression.
