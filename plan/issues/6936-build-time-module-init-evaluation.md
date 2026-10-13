---
id: 6936
title: "Evaluate top-level module initialization at compile time and seed IR analysis from the resulting heap"
status: ready
sprint: Backlog
created: 2026-10-10
updated: 2026-10-10
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: research
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [6934, 6935, 3142, 5332]
---

# #6936 — Build-time module-init evaluation as an analysis seed

Follow-up from [`plan/log/nightmonkey-analysis.md`](../log/nightmonkey-analysis.md)
lesson 3. Two separable things are discussed here; only the first is this
issue's deliverable. **[confirmed]** = read in source on 2026-10-10 at the
cited location; **[proposed]** = design.

## Problem

**[confirmed]** js2 knows *what* module initialization does but never
*executes* it at compile time. `buildIrModuleInitPlan`
(`src/ir/module-init-plan.ts` L190) produces an `IrModuleInitPlan`
(`src/ir/program/startup.ts` L79–89): bindings with their TDZ/`undefined`
initialisation, **live seeds** (callable bindings published at instantiation),
an ordered list of **evaluations** (`statement`, `variable-initializer`,
`export-assignment`, `class-static-field`, `class-static-block`, L36–41),
exports, an invocation policy (`wasm-start` / `deferred-export` /
`wasi-start-export`, L5) and gaps. `src/ir/module-init.ts` collects the
runtime top-level statements into the synthetic `<module-init>` unit (#3142)
and `reconcileIrModuleInitPlan` (L540) keeps that in parity with the legacy
`__module_init` queue.

The only compile-time *evaluation* of module-level state is
`src/ir/fnctor-module-consts.ts` (#743), which proves a top-level `var X = 1`
is a Number under three obligations — constant numeric initializer, never
written anywhere in the module, no read can observe the hoisted `undefined`
(header L17–36). Everything else at module level — lookup tables, singleton
objects, `const protoMethods = {...}`, class prototypes assembled by
statements, frozen enums — is `dynamic` to every analysis and is re-executed
at every instantiation.

## Motivation (NightMonkey evidence)

NightMonkey's deployment is "concrete interpretation of init, abstract
interpretation of run" (slides; DESIGN.md §2 "Snapshot flow": the shell runs
registration and initialisation, **Wizer** captures the module, the compiler
"constructs `Source`" from that snapshot). §4 "Calls and heap": "Snapshot
state seeds the same cells that later program writes update." Its lessons
slide names the **init phase + snapshot hypothesis** as a requirement of the
approach, and the ablation attributes 0.88× to interprocedural arg/return
types and 0.76× to heap abstractions — both of which start from the concrete
heap in their design. Octane itself is built this way (setup code builds the
object graph; `run` loops over it), as is most library code js2 dogfoods
(acorn's token tables, pako's CRC tables).

## Current js2 state (cited)

| Piece | Where | Status |
| --- | --- | --- |
| Module-init inventory | `src/ir/module-init-plan.ts`, `src/ir/program/startup.ts` | **[confirmed]** complete, backend-neutral, verified by invariants (`IrModuleInitPlanInvariantError`, module-init-plan.ts L27–34) |
| Module-init population / synthetic unit | `src/ir/module-init.ts` (#3142, #5332) | **[confirmed]** lowered as an IR unit; parity-observed against legacy |
| Numeric module constants | `src/ir/fnctor-module-consts.ts` | **[confirmed]** syntactic proof, numbers only, ES-module only |
| Constant folding | `src/ir/passes/constant-fold.ts` (#1167a) | **[confirmed]** `binary(const,const)` and `br_if(const)` only; no object/array literal materialisation |
| Startup measurement | `benchmarks/cold-start/` (wasmtime vs wasm-in-node vs js-in-node, median of N fresh processes) | **[confirmed]** exists; not Wizer-aware |
| Prior Wizer contact | #1125 (StarlingMonkey/ComponentizeJS lane uses Wizer pre-init) | **[confirmed]** external engine only; no snapshot of js2 output |

## Implementation Plan

### Part 1 — compile-time evaluation of the init plan [proposed]

**Mechanism.** Interpret the `evaluations` list of each `IrModuleInitPlan`
in plan order against an abstract-but-concrete heap: a small evaluator over
the *IR* of the `<module-init>` unit (not the AST, so it sees the same
`object.new`/`object.set`/`class.new`/`vec.*`/`global.set` instrs analysis
sees). Each evaluation either **completes** (every instr is a literal,
constructor of a known class, array/object literal, arithmetic, string op, or
a call to a unit the evaluator can also complete under a step budget) or
**refuses** (host import, `extern.*`, `coerce.to_externref`, `Date`/`Math.random`,
`globalThis` reads, unbounded loop, budget exceeded). Refusal is per
evaluation and **stops** the evaluation of everything after it in plan order
(a later statement may observe the refused one's effects); completed prefixes
are kept.

**What completion produces.** A *seed heap*: for each `global.set`/binding
the plan owns, a concrete value (number, string, or a graph of
`site`-abstracted objects with concrete field values). This seeds:

1. `propagate.ts` — binding types become exact atoms instead of `unknown`
   (through the existing `DtsEntrypointSeeds`-style seed input, not by
   widening its population — same guard as #743).
2. `fnctor-module-consts.ts` — generalises from "numeric literal, never
   written" to "any completed value, never written": the STABILITY and
   INITIALISEDNESS obligations (header L17–36) stay exactly as they are; only
   the VALUE obligation is replaced by "the evaluator completed it".
3. [#6935](6935-ir-capped-points-to-heap-lattice.md)'s heap lattice — every
   object in the seed heap is a `site` with known field facts, which is the
   "snapshot state seeds the same cells" idea.

**What completion does NOT do in this issue:** replace the emitted init code
with data segments or pre-built `struct.new` constants. That is the natural
second step (and where the startup win is) but it changes emitted bytes and
has its own equivalence burden; this issue is analysis-only and byte-identical
by default.

**Files [proposed; Session A to confirm]:** new `src/ir/analysis/init-eval.ts`
(evaluator + refusal codes), `src/ir/module-init-plan.ts` (expose evaluation
→ IR-unit mapping; no plan shape change), `src/ir/fnctor-module-consts.ts`
(VALUE obligation accepts evaluator results), `src/ir/propagate.ts` (seed
input only), telemetry row in the compile result next to `irPostClaimErrors`
(`src/index.ts`) counting completed/refused evaluations per module.

### Part 2 — Wizer snapshotting of js2 output (noted, separate) [proposed]

Orthogonal to Part 1: run js2's *emitted* module once under Wizer (or an
equivalent `wasm-start` pre-run) and ship the post-init instance. For the
WasmGC backend this is **not currently possible** — Wizer snapshots linear
memory and globals, not GC heaps — so it applies to the **linear** and
**Porffor/native** lanes only, and there it interacts with ADR-0017/0022's
arena and heap placement (the bump pointer and `__heap_ptr` would be
snapshotted mid-arena). File separately once #874's startup column shows
init time is material; `benchmarks/cold-start/` already measures the right
quantity. Not in this issue's acceptance criteria.

### Owner implications

`module-init-plan.ts`, `module-init.ts`, `program/startup.ts` and
`propagate.ts` are in the shared IR scope Session A integrates (#3518;
`plan/issues/6920-native-linear-shared-source-handoff.md`). **Needs Session A
acknowledgement before implementation.** Part 1's evaluator can be developed
and reported from a read-only script first.

## Acceptance criteria

- [ ] `init-eval.ts` completes or refuses every evaluation of every
      `IrModuleInitPlan` in `website/playground/examples/`, the acorn corpus
      and the #874 Octane sources, with a refusal code per refused entry.
- [ ] Report committed under `plan/log/`: per module, evaluations completed /
      refused, and the top refusal codes.
- [ ] `fnctor-module-consts.ts` accepts evaluator-completed values with its
      STABILITY and INITIALISEDNESS obligations unchanged (tests show a
      written binding and an early read still refuse).
- [ ] Default output byte-identical (equivalence gate green); seeds active
      only behind a compile option until a consumer measures a win.
- [ ] Step budget and refusal set documented; no evaluation may call a host
      import or observe `Date`/`Math.random`.

## Measurement plan

- **Analysis precision:** count of `dynamic` top-level bindings before/after
  seeding, on the three corpora above.
- **Runtime:** Octane via the [#874](874-benchmark-compare-all-js-to.md)
  harness once landed (Richards/DeltaBlue build their object graphs in
  setup); interim `benchmarks/cross-engine/` with checksum match, same
  session, min-of-5.
- **Startup (Part 2 only, if filed):** `benchmarks/cold-start/` load +
  execute time, median of 10, wasmtime lane.

## Risks

- **Observable evaluation order.** A refused evaluation must stop the prefix;
  evaluating past it could seed a value the real init never produces. The
  stop rule is non-negotiable and needs a test.
- **Non-determinism leaking in** (`Date.now()`, `Math.random()`, host state):
  refusal set, enforced by the evaluator refusing any `extern.*` /
  host-import call, not by a blocklist of names.
- **Scripts vs modules.** `fnctor-module-consts.ts` already refuses script
  top-level `var` because it is a writable `globalThis` property (header
  L37–40); the evaluator inherits that rule.
- **Double authority on module init.** The plan (`module-init-plan.ts`) stays
  the single inventory; the evaluator consumes it and never re-derives the
  statement list from the AST.
- **Wizer and WasmGC** do not combine today; Part 2 must not be promised for
  the default backend.
