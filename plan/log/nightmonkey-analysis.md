# NightMonkey (Fallin, VMIL 2026) — what js2 takes from it, and what it does not

**Author:** Claude Fable 5.1 (planner lane) · **Date:** 2026-10-10 · **Base:**
`origin/main` at branch creation. Sources: the VMIL 2026 slides
(`cfallin.org/pubs/vmil2026_nightmonkey_slides.pdf`) and the repository
`github.com/cfallin/nightmonkey` at commit `88cbb0c` (`docs/DESIGN.md`). The
repository carries **no license file**, so this document records ideas only;
no code, identifiers or comments were copied.

## What NightMonkey is

An ahead-of-time tier for **SpiderMonkey compiled to wasm32-wasi**. The engine
and the compiled JavaScript share one Wasm module and one linear memory; the
compiler consumes **SpiderMonkey bytecode**, not source. The deployment is
"concrete interpretation of init, abstract interpretation of run": the shell
runs module initialisation, Wizer snapshots the heap, and the analysis starts
from that concrete heap (DESIGN.md §2, §4).

Its analysis, `likelier`, is **optimistic and unsound by design**:
call-string-sensitive, flow-sensitive on locals, whole-program. Its results are
*predictions*; a codegen fact may only come from a dominating runtime guard or
an exact producer (§4 "Representations and proofs"). Codegen emits two tracks
per function — **OPT** (unboxed, specialised) and **GEN** (boxed, runtime
helpers) — with *offramps* (failed guard → GEN) and *onramps* (GEN re-proves
the facts → OPT). Objects carry a 32-bit **stamp** (layout key + validity
bits) so one guard per reference makes every property read unchecked. Loop
headers are baked into a block's version identity so the duplicated tracks
keep the Wasm CFG reducible (§5–§6).

Reported results on Octane: NightMonkey ≈ 2.45× slower than Ion (geomean),
13.4× faster than the Wasm-hosted interpreter, 7.89× faster than weval.
Ablation (speed relative to the full build): no likely types **0.44×**, no
heap abstractions **0.76×**, no direct call targets **0.82×**, no inlining
0.87×, no slot predictions 0.88×, no interprocedural arg/return types 0.88×,
no int32 specialisation 0.89×, no MIR opts 0.95×.

## Why js2 does not adopt NightMonkey's IR or code

The two projects answer different contracts, so the artefact is not reusable
even setting the missing license aside:

| Axis | NightMonkey | js2 |
| --- | --- | --- |
| Input | SpiderMonkey bytecode of a snapshotted program | TypeScript / JavaScript source through the TS checker (`src/ir/from-ast.ts`, ADR-011) |
| Runtime | Embedded SpiderMonkey; compiled code calls engine helpers in the same linear memory | No embedded engine on the WasmGC backend (ADR-002/003); the linear backend's dynamic tier is a *linked* quickjs-ng, eval-reachable residue only (ADR-0020) |
| Values | Boxed `JS::Value` everywhere in the heap; unboxing is a codegen-local carrier | WasmGC struct types per shape (ADR-005), `f64`/`i32` unboxed by proof, `externref`/boxed `$AnyValue` only for the dynamic residue (#1852) |
| Correctness floor | GEN track + engine interpreter for untranslatable scripts (§12) | The direct AST→Wasm front end, reached by **compile-time demotion** when the IR selector or a post-claim stage declines (`src/codegen/index.ts` `STRICT_IR_REASONS` comment block, ~L2290–2420) |
| Code multiplication | Basic-block versioning keyed on PC × track × loop tokens × inline depth | Single structured IR with control flow in nested instruction buffers (ADR-018); reducible by construction |

NightMonkey's IR therefore encodes assumptions js2 has deliberately not made
(an engine to fall back into, boxed heap slots, bytecode-level versioning).
What transfers are the *principles* and the *measurements*.

## What js2 already has (confirmed)

- **Types as hypotheses, not facts — existing policy.** ADR-009
  (`docs/adr/0009-typescript-annotations.md`) states that annotations "seed
  the inference ... but every lowering decision requires *proof* from the
  analysis"; ADR-001 §Decision item 3 and ADR-006 restate it. NightMonkey's
  "future work: ingest TS annotations as likely-type seeds" is js2's starting
  point, so nothing is proposed there.
- **Optimistic fixpoint with a conservative certifier.** `src/ir/propagate.ts`
  L60–73 documents the optimistic-start-and-refine rule (`unknown + unknown →
  f64`), and `src/ir/type-evidence.ts` L3–6 exists precisely to stop the
  linear selector from "treating that optimism alone as an ABI proof".
  Difference from NightMonkey: js2 resolves the optimism **at compile time**
  (certify or demote), NightMonkey resolves it **at run time** (guard or
  offramp).
- **Heap/ownership analyses exist but are shape-keyed, not alias-keyed.**
  `src/ir/analysis/alloc-registry.ts` (#1586, per-site identity + namespaces
  `ownership`/`encoding`/`lifetime`/`escape`, L117–127),
  `src/ir/analysis/ownership.ts` (#1587, intra-procedural, unknown callee =
  fully escaping, L17–18), `src/ir/analysis/escape.ts` (#747),
  `src/ir/fnctor-field-lattice.ts` + `fnctor-method-edges.ts` (#743, field
  slots as lattice variables for function-style constructors). None of them
  answers "which allocation sites can this value be?" for a receiver whose
  static type is `object`/`dynamic`.
- **Module init is planned, not evaluated.** `src/ir/module-init-plan.ts`
  (`buildIrModuleInitPlan`, L190) produces a semantic inventory — bindings,
  live seeds, ordered evaluations, exports, gaps (`src/ir/program/startup.ts`
  L79–89) — and `src/ir/fnctor-module-consts.ts` proves individual numeric
  module constants syntactically. No pass executes top-level code at compile
  time or seeds analysis from a resulting heap.
- **Fallback telemetry exists.** `JS2WASM_LOG_IR_FALLBACKS=1`
  (`src/codegen/index.ts` ~L3038), `irPostClaimErrors` on the compile result
  (`src/index.ts` ~L398–409, #1923) and `pnpm run check:ir-fallbacks`
  (`scripts/ir-fallback-baseline.json`, whose `unintended` and `postClaim`
  sections are empty on the playground corpus as of 2026-08-03).

## What we learn, and where each lesson lands

1. **Guards instead of demotion** (ablation: likely types alone are worth
   2.3×; NightMonkey never gives a function up wholesale). js2 today demotes a
   whole unit to the direct front end when one fact cannot be proven; a
   guarded fast path with a boxed slow path keeps the proven part. Spike:
   [#6934](../issues/6934-ir-optimistic-track-runtime-fallback.md) — one
   construct, measured, before any architecture commitment. Open questions it
   must answer: how a GEN track represents values on WasmGC (`externref` vs
   boxed `$AnyValue`), on the linear backend (#1852's f64+i32 scheme vs
   ADR-0020's `JSValue`), and in standalone mode (no host to box into).
2. **A capped points-to lattice beats both "exact shape" and "unknown"**
   (ablation: heap abstractions 0.76×, direct call targets 0.82×). The
   alloc-site < class < union-find-region < any ladder with a Steensgaard cap
   gives the dynamic-object residue *some* structure where js2 currently has
   none. Plan: [#6935](../issues/6935-ir-capped-points-to-heap-lattice.md),
   explicitly as an extension of the alloc-registry namespaces, not a parallel
   authority.
3. **Init-phase evaluation turns module-level state into facts.** NightMonkey
   depends on an init+snapshot hypothesis; js2 already has the inventory of
   what module init does and a constant-prover for a sliver of it. Plan:
   [#6936](../issues/6936-build-time-module-init-evaluation.md), with Wizer
   snapshotting of js2's *output* noted as a separate startup lever.
4. **Validation lesson (adopt as-is, no issue).** A shell that silently
   interprets declined scripts proves nothing about compiled coverage. js2's
   analogue is the demote-to-warning channel; `check:ir-fallbacks` and
   `irPostClaimErrors` are the counters that keep it honest, and the #3341
   per-reason promotion bar is the right instrument. Do not read a green
   test262 row as "compiled by the IR".
5. **Lessons slide, agreed.** "Simple principles beat heuristic soup" and
   "don't fight Rice's theorem" match ADR-001's proven-invariants rule. Their
   own TODO — one opcode capability table for effects, lowering and splice
   safety, because the classification is duplicated today — is what #2134
   (`src/ir/analysis/effects.ts`) already does for js2; keep it the single
   source when #6934 adds guard/track metadata.

## Not adopted

Object stamps as a header word (js2 objects are typed WasmGC structs; a
`ref.test`/`br_on_cast` *is* the stamp), fuses for global rebinding (js2's
module-constant prover already refuses on any write), bytecode-level BBV, and
the SpiderMonkey helper ABI.
