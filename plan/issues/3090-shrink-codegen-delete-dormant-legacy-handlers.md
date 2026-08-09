---
id: 3090
title: "Retire direct front-end after IR-only reachability gates close (~59,676 fn-lines)"
status: blocked
# Phase 0 (audit) landed 2026-07-10; Phase 2 (unreferenced/dead deletions,
# slices 2a/2b/2d/2e) is EXHAUSTED as of the 2026-07-16 Phase 2f re-run — the
# residue is exactly the 16 deliberate keeps in the dead-export baseline (see
# "## Phase 2f" below). Every remaining deletion is hard-gated on #3518 R0a–R9
# (including the #3529 typed-producer parity prerequisite):
# typed outcome coverage, prepare-before-emit ownership for every unit kind,
# whole-program M0/runtime/linear consumption, and fail-closed IR-only default.
# BLOCKED until R9 lands and a fresh reachability audit proves exact targets
# dead — do NOT claim for ad-hoc deletion hunting.
sprint: Backlog
created: 2026-07-08
updated: 2026-07-21
priority: high
horizon: xl
complexity: XL
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
related: [2855, 2856, 3142, 3143, 3518, 3519, 3529, 3520, 3521, 3522, 3523, 3525, 3526, 3527, 3528]
---

# #3090 — Retire the direct front-end after IR-only reachability gates close

> **Reconciled 2026-07-21:** the remaining handlers are not dormant. The latest
> audit found **59,676 frontend-only fn-lines**, but default-on hybrid compilation
> still reaches them through compile-twice functions, class members, module
> init, multi-source/M0, and direct linear lowering. #3518 is the gate-clearing
> program; this issue is its R10 deletion ledger. Do not dispatch deletion
> slices before #3518 R9 makes IR-only fail-closed and a refreshed reachability
> audit proves the exact targets dead. #3529 restored equivalence parity while
> preserving strict typed Invariant classification; neither reclassification
> nor baseline expansion is reachability evidence.

The concrete gate spine is #3520 (R1 identity/ABI), #3521 (R2 Prepared free
functions), #3522 (R3 classes/closures), #3523 (R4 ordered module init), #3525
(R5 whole-program ownership), #3526 (R6 semantic runtime contract), #3527 (R7
AST-free async plans), and #3528 (R8 shared linear consumption). All must
preserve any direct implementation still needed for typed hybrid Unsupported
outcomes; none authorizes general deletion from this ledger.

## Why (motivation)

The compiler ships **two front-ends at once**: the legacy direct AST→Wasm
path (`src/codegen/`, accumulated hacks) and the typed IR
(`src/ir/`, `from-ast.ts` → `lower.ts` → `backend/`). With
`experimentalIR: true` the default, an IR body may ship for a selected unit,
but many units still retain or exclusively use the legacy body. Even an
IR-emitted unit may have been compiled twice before its slot was patched.
That duplication is the single biggest reason the compiler is ~6.4× the
size of a comparable linear-memory TS→Wasm compiler (Porffor: ~32K code
vs our ~207K).

`#2855` (+ `#2856`–`#2859`) drove a bounded function fallback corpus to zero,
but that does not make legacy bodies globally unreachable. #3518 R0–R9
establishes typed fail-closed, prepare-before-emit ownership; this issue then
performs the complementary R10 subtraction pass.

## Measured opportunity (tokei, 2026-07-08 baseline)

`src/codegen/` = **154,938** code lines / 150 files. Three-way split:

| Bucket                                                                                                                                                                                                                                                                       |    Code | Disposition   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ------------- |
| **STAYS** — substrate/orchestrator the IR reuses (`index.ts`, `coercion-engine`, `js-tag`, `value-tags`, `native-strings`, `registry/`, `context/`, `regex/`, `statements/{loops,control-flow}`…)                                                                            | ~35,221 | keep          |
| **RUNTIME** — stdlib _behavior_ emission (`object-runtime`, `array-methods`, `property-access`, `native-regex`, `map-runtime`, `dataview`, generators…) — the IR backend calls it; a front-end swap does not remove the need to emit an array `.map` loop or a regex matcher | ~39,635 | **keep**      |
| **FRONTEND** — AST→Wasm dispatch & lowering that `from-ast.ts`/`lower.ts` replace (`expressions/`, operator/closure/literal/object lowering, statement lowering…)                                                                                                            | ~80,082 | **deletable** |

**Net estimate: ~40–55K code lines removed** after (a) subtracting ~8–10K
of FRONTEND-classified files that are really shared emission passes
(`stack-balance.ts`, `type-coercion.ts`, `regexp-standalone.ts`), and
(b) offsetting ~15–25K of IR growth needed to finish the remaining
`mixed`/`direct-only` kinds. That takes `src/` from ~207K → **~155–165K
code (~20–27% smaller compiler)** with **no capability change** for the
Phase‑1 slice. It does _not_ close the gap to Porffor — RUNTIME (~40K) and
WasmGC substrate (~35K) are intrinsic to targeting WasmGC with a full
stdlib.

## Scope — what to delete vs never touch

**Delete (only):** legacy direct-codegen handlers that a post-R9 reachability
audit proves have no caller. An `ir-owned` adoption row is not sufficient
evidence: the current matrix has 18/56 such rows, yet mixed units can still
reach every handler they contain.

**Never touch:**

- Any file in **STAYS** or **RUNTIME** (substrate + stdlib behavior).
- **Deferred** syntax is not a permanent direct-path exception. #3518 R7 makes
  supported async behavior IR-owned and turns deliberately unsupported syntax
  into explicit diagnostics; R10 can then delete its direct handlers.
- Any handler for a `mixed`/`direct-only` kind — the legacy path is still
  live until #3518 prepares every containing unit, R9 makes IR-only fail
  closed, and R10's fresh reachability audit proves the handler has no caller.

## Plan (Fable-friendly: mechanical, sliceable, test-gated)

**Phase 0 — audit → ranked delete-list (1 slice, `s`/`m`).**
Per-function attribution over the 89 FRONTEND files: mark each exported
function legacy-only vs shared, by call-graph reachability from the
non-IR branch in `src/codegen/index.ts` (the demote-to-warning fallback
~`index.ts:889`). Output a checklist doc under `plan/log/` mapping
{kind → file → deletable functions → LOC}, cross-checked against the
`ir-owned` rows of `plan/log/ir-adoption.md`. Replaces the ±10K estimate
band with a hard number and becomes the work-list for Phases 1–2.

**Phase 1 — historical proposal, superseded.** The planned per-`ir-owned`-kind
deletion is unsafe because adoption labels do not prove whole-unit
compile-once reachability. #3518 R10 instead deletes only functions a post-R9
audit proves unreachable.

**Phase 2 — dead-code sweep (1 slice, `s`).**
No `knip`/`ts-prune` is configured today. Add `knip` to the `quality` CI
job and delete the orphaned exports it flags across `src/codegen/`
(handlers stranded by refactors, helpers no longer dispatched). Low-risk
mechanical win; catches residue Phase 1 leaves behind.

**Phase 3 — superseded by #3518 R0–R10.** Bucket/adoption changes continue as
telemetry, but handler deletion waits for #3520–#3523, #3525–#3528, and
fail-closed R9 ownership.

## Phase 0 audit landed (2026-07-10)

Deliverables: `scripts/audit-legacy-reachability.mjs` (call-graph
reachability, re-runnable, `--why` path tracing) +
`plan/log/3090-phase0-legacy-delete-list.md` (ranked delete-list, hard
numbers, kind→file mapping).

**Hard numbers:** FRONTEND legacy-only = **59,976 fn-lines** across 35 files
(ranked list in the doc); deletable-NOW (unreferenced) ≈ **2.1K fn-lines**
(index.ts `collect*Imports` family ~1.4K, regex/vm.ts 245, strays).

**Premise correction — handler deletion is GATED, not free:** the
whole-function claim unit, compile-twice classes/module init, incomplete M0 /
linear consumption, and ~47K runtime-entry lines keep the handler graph live.
See #3518 for the current structural gate sequence.

## Acceptance criteria

- [x] Phase 0 audit doc committed with a hard deletable-LOC number + ranked
      per-file/per-kind delete-list. (2026-07-10,
      `plan/log/3090-phase0-legacy-delete-list.md`)
- [ ] `src/codegen/` shrinks by **≥ 30K code lines** net across Phases 1–2
      (stretch: ≥ 45K), measured by `tokei src` before/after (baseline
      `src` = 206,674 code; `src/codegen` = 154,938).
- [ ] **Zero test262 regressions** vs baseline on `merge_group` for every
      slice; equivalence suite green.
- [ ] Runtime/substrate behavior is retained or moved behind typed IR intents;
      no behavior implementation is deleted merely because its current entry
      edge comes from AST dispatch.
- [x] Dead-export gate wired into the `quality` CI job (Phase 2); no new
      orphaned exports. (2026-07-10 — implemented **dep-free** via the Phase 0
      audit tool instead of `knip`: `pnpm run check:dead-exports` ratchets the
      unreferenced set against `scripts/dead-export-baseline.json`, same
      baseline/--update convention as the other quality ratchets. `knip` can
      still be added later if repo-wide unused-dependency coverage is wanted;
      for the #3090 enforcement goal the audit tool is a superset for
      src/codegen and adds no dependency. Phase 2a PR #2856 deleted the dead
      `collect*Imports` family (-1,474); Phase 2b PR #2858 the remaining
      strays (-332).)

## Phase 2d — fresh audit re-run + confirmed-dead deletions (2026-07-11)

Fresh `audit-legacy-reachability.mjs` run @ `026f40f771` (main advanced ~25
PRs since Phase 0): FRONTEND legacy-only grew 59,976 → **61,118** fn-lines
(calls.ts 16.2K → 16.9K — the legacy front-end is still growing; motivates
Phase-3 coupling). Remaining unreferenced set: **470 fn-lines** across all
buckets, of which `regex/vm.ts` (245) is a deliberate keep (executable
reference spec — `native-regex.ts` imports `REGEX_STEP_CAP`; `search` is the
oracle in `tests/regex-bytecode.test.ts` / `tests/issue-2091-*`), and 9 more
functions are test-imported (audit's known tests-blind-spot:
`value-tags` trio, `getBuiltinParent`, `withSpeculativeCompile`,
`fallback-telemetry` pair, `quickJsLibRegexpEngineConfig`, index.ts
`getPseudoExternClassInfo`/`resolveMethodDispatchTarget`).

Deleted the confirmed-dead residue (-198 lines): `expressions.ts` superseded
`emitCoercedLocalSet`/`updateLocalType`/`widenLocalToNullable` trio (live
copies live in `expressions/helpers.ts`), `index.ts#registerExternClassImports`,
`type-coercion.ts#emitSafeExternrefToF64`, `registry/types.ts#valTypeEq`
(`emit/binary.ts` has its own local copy), `async-cps.ts` PR1 stubs
(`compileNestedAwait`/`emitAsyncStateMachineFromIr`), `timsort.ts#LT`.
Dead-export baseline ratcheted 36 → 16 entries (19 stale entries from
already-landed deletions also cleared). Byte-inertness proven: 13 playground
examples × 2 string modes SHA-identical vs base commit.

## Phase 2e — dead `UndefinedKeyword`-as-expression handler + disjuncts (2026-07-13, opus-dead)

A **structurally-dead** (not merely unreferenced) deletion the static
reachability audit cannot see, found via the byte-identity oracle.

**Root cause / WHY it is dead:** in TypeScript's parsed AST the value
`undefined` is always an `Identifier` (text `"undefined"`); the
`UndefinedKeyword` SyntaxKind is emitted **only in type position**
(`x: undefined`), never as an `ts.Expression`. Verified with an AST probe
over every value/type occurrence (0 expression-position `UndefinedKeyword`,
type-position only) and a repo-wide scan confirming nothing synthesizes an
`UndefinedKeyword` **expression** node and feeds it to the dispatcher. So the
`compileExpressionInner` dispatch arm `if (expr.kind === UndefinedKeyword)`
was a dead handler branch, and the three `inner.kind === UndefinedKeyword ||`
disjuncts in the numeric / ref / any-value null-fast-paths were always-false
`||` operands (the companion `ts.isIdentifier(inner) && inner.text ===
"undefined"` clause is the live one and is retained).

Note this is why the audit's static reachability marked these regions "live":
the enclosing functions ARE reached; only the specific `UndefinedKeyword`
sub-conditions are unreachable — a case only the emit-byte oracle catches.

**Deleted** (all in `src/codegen/expressions.ts`, my lane): the dead dispatch
arm in `compileExpressionInner` + the 3 dead disjuncts in
`compileExpressionBody`. **Net −14 LOC** (3 ins / 17 del); `emitUndefined`
retains 8 live callers (no orphaned symbol).

**Byte-identity PROOF of dead-ness:** `prove-emit-identity check` over the full
`website/playground/examples/` corpus × {gc, standalone, wasi} = **39/39
(file,target) emits IDENTICAL** to the pre-edit golden baseline. Behaviour
cross-check: the null/undefined equivalence batch (11 files, 83 cases)
produces the **same 8 pre-existing failures** (`null-dereference-guards`
#396) with and without the change — **zero delta**. typecheck / prettier /
`check:dead-exports` / `check:ir-fallbacks` / `check:loc-budget` all green.

## Phase 2f — audit re-run: Phase 2 EXHAUSTED (2026-07-16, fable-3132-s2)

Fresh `audit-legacy-reachability.mjs` run @ current main (post-#3129):

- FRONTEND legacy-only **59,676** fn-lines (down from 61,889 post-flip /
  61,118 @ Phase 2d — the WAVE-C extractions and #3287-style deletions are
  shrinking the front-end even while gated).
- Unreferenced/dead residue across ALL buckets: **335 fn-lines in 16
  functions — every one a documented deliberate keep**: `regex/vm.ts`
  (runAt/search/classMatch/asciiFold/isLineTerminator/isWordChar — the
  executable reference spec, oracle for `tests/regex-bytecode.test.ts`), and
  the test-imported set (value-tags trio, `getBuiltinParent`,
  `withSpeculativeCompile`, fallback-telemetry pair,
  `quickJsLibRegexpEngineConfig`, extern-declarations pair). `pnpm run
check:dead-exports`: **OK, 16 known entries, 0 new**.

**Conclusion: there is no deletable-today residue left.** Phase 2 (2a −1,474 /
2b −332 / 2d −198 / 2e −14) has fully harvested the unconditional lane. All
remaining shrinkage is #3518 R10 handler deletion. The umbrella remains
`blocked` until R9 lands and a fresh audit proves exact call edges gone; no
“first file” is predicted from adoption labels or the 28.1% allowlist ceiling.

## Guardrails / hazards

- **Broad impact** — each deletion slice touches the shipping compiler;
  validate on full CI / `merge_group`, not a scoped issue sweep
  (see memory `project_broad_impact_validate_full_ci`,
  `project_standalone_floor_only_on_merge_group`).
- **Don't confuse RUNTIME with FRONTEND** — `array-methods`/`object-runtime`/
  `native-regex` have zero IR imports today but emit behavior both paths
  need; deleting them breaks features. Only delete what Phase 0 proves is
  reachable _solely_ via the legacy front-end dispatch.
- **Late-import funcidx discipline** — codegen is sensitive to function-index
  shifts; deleting a handler that registered helper imports can shift
  indices. Re-run the standalone floor on `merge_group` for any slice that
  removes an import-registering helper.
- One slice = one kind/file = one PR; keep slices small so a regression
  bisects to a single deletion.

## Notes

Suited to a Fable dev fleet: Phase 1/2 are high-confidence, mechanical,
per-slice deletions gated by strong existing test coverage — parallelizable
across several devs with low collision risk (distinct files per slice).
Phase 0 (the audit) is a good first single-owner task; consider a fan-out
over the 89 FRONTEND files to produce the delete-list quickly.
