---
id: 6768
title: "perf(codegen): every standalone test262 compile rebuilds and walks a ~650-function runtime floor, 39 % of it unreachable"
status: done
completed: 2026-09-30
sprint: current
priority: high
horizon: l
goal: maintainability
reasoning_effort: max
assignee: ttraenkler/claude-lead
requested_by: ttraenkler/claude-lead
created: 2026-09-30
related: [6759, 6722, 6723]
# 2026-09-30 (lever 1): the sweep itself lives in the new
# src/codegen/function-reachability-sweep.ts; index.ts only gains its import,
# one post-inline sweep call and one post-finalize verifier call in EACH of the
# two pipelines (generateModule / generateMultiModule), which must sit at those
# exact driver seams (after inlineUserFunctions, after the last finalize pass).
loc-budget-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
# 2026-09-30 (lever 1): not a coercion — `__unbox_number` appears as a sweep ROOT
# NAME (LATE_PASS_HELPER_ROOTS), because stack-balance / cross-hierarchy /
# fixups may insert a fresh `call` to it after the sweep has run.
coercion-sites-allow:
  - src/codegen/function-reachability-sweep.ts
---

# #6768 — the standalone runtime floor dominates per-test compile time

## Problem

After #6759 (merge-queue standalone shard median 657 s → 505 s), no single
pass dominates a standalone test262 compile any more. The cost is the **size
of every module**: a 330-line test compiles to 670 functions / 136k
instructions / 474 KB, and every whole-module pass walks all of it.

Measured 2026-09-30 on main `54a85ebdda`, the 40-row seed-7 sample
(`.tmp/prof/files.txt`), `JS2WASM_COMPILE_PROFILE=1`, 52.8 s total:

| phase | share |
|---|---:|
| `codegen` self (≈20 unlabelled whole-module passes, 1–3 % each) | 44.9 % |
| `bodies/module-init-pass1` + `pass2` (test + harness code) | 17.3 % |
| `finalize/*` repair passes (ir-inline, stack-balance, cross-hierarchy, peephole, extern-convert-any, repair-struct) | ~26 % |
| `finalize/dead-layout` | 5.8 % |
| `emit-binary` | 3.6 % |

Per-module scale (`[js2:profile] scale before-finalize`): 670–1391 functions,
136k–358k instructions. The function count going into finalize equals the
count in the emitted binary: `eliminateDeadImports`
(`src/codegen/dead-elimination.ts`) is the only dead-code sweep and it removes
imports, not functions.

### Reachability (measured)

`wasm-opt --all-features --remove-unused-module-elements` over the same 40
rows (script `.tmp/prof/reach.mts`):

- functions **28,399 → 17,385** — **61.2 % reachable**, 38.8 % dead;
- bytes 21.9 MB → 16.1 MB (73.5 %);
- per row 58–62 % reachable, very uniform;
- even a trivial row keeps ~400 reachable functions — the **runtime floor**.

## Two levers — do both

### Lever 1 — sweep unreachable functions before the finalize passes

Add a function (and dependent global/type) reachability sweep between body
compilation and the first finalize pass, so repair-struct, peephole,
ir-inline, cross-hierarchy, stack-balance, extern-convert-any and emit walk
~61 % of today's functions.

- Roots: exports, start function, element segments / `ref.func` targets,
  declared-func-refs (`collectDeclaredFuncRefs`), anything the runtime-eval /
  host ABI calls by index or name, and the program-ABI plan
  (`eliminateDeadLayoutAndPlanProgramAbi`, `src/codegen/program-abi-finalization.ts`).
- Edges: `call`, `return_call`, `ref.func`, plus any index-carrying
  side tables the codegen keeps (trampolines, closure exports, vtables).
- Remap function indices with the same machinery `eliminateDeadImports`
  uses (late index shifts are a known hazard — see CLAUDE.md
  "addUnionImports").
- Acceptance: output **validates**; test262 standalone verdicts unchanged
  in the merge group (edition ratchet, #1897 guard); host lane unaffected or
  also gated; equivalence gate no new failures; measured compile time on the
  40-row sample and merge-queue shard median reported.

### Lever 2 — build the runtime floor once per process, reuse it per test

The ~400 always-reachable runtime functions are identical across tests with
the same compile options. Compile them once per worker process (keyed by the
compiler bundle hash + the option fingerprint that affects runtime
emission), snapshot the resulting functions/types/globals, and seed each
test's module from a clone of the snapshot instead of regenerating them.

- First step is a measurement: which runtime helpers are emitted
  unconditionally vs on demand, and whether their bodies are byte-identical
  across the 40 rows. Only the invariant part is snapshotted.
- Clone must be deep (instruction arrays are mutated by finalize passes —
  see #6759's sharing analysis).
- Acceptance: **byte-identical** output vs its own base (main, or main +
  lever 1 if that lands first) on the 40-row sample
  and the equivalence corpus; compile time reported the same way.

## Measurement protocol

Both levers report: 3 interleaved base/new rounds on the 40-row sample, no
profiler (as in #6759), plus merge-queue standalone shard median/max after
merge. Capture `.tmp/base` copies at the first edit (CLAUDE.md).

## Lever 2 implementation

**Status: not implemented — stopped at the step-1 measurement (2026-09-30,
senior-dev, Opus 5 Max).** The brief's own gate applied: the invariant part
is too small and too entangled to snapshot under the byte-identity
acceptance. Nothing under `src/` changed.

### What was measured

40-row seed-7 sample (`.tmp/prof/files.txt`), `target: "standalone"`, base
`0dbe04213b`; 36 rows produce a module (4 are early-error rows with an empty
binary). Tools: a final-binary parser (name section + code bodies) and
temporary `mod.{types,functions,globals}` checkpoints in `generateModule`
(reverted; not committed).

**1. The runtime floor is emitted lazily, in first-demand order, during body
compilation.** Function counts at checkpoints (mean [min–max] over 36 rows):

| checkpoint in `generateModule` | types | functions | globals |
|---|---:|---:|---:|
| after `createCodegenContext` | 10 | 0 | 0 |
| before `collectAllSourceImports` | 19 [19–21] | 0 | 0 |
| after `collectAllSourceImports` (native string/number runtime) | 78 [77–82] | 86 [86–87] | 29 |
| before `bodies` | 90 [84–110] | 101 [94–127] | 36 [30–55] |
| before `finalize/dead-layout` | 451 [385–849] | 789 [668–1469] | 882 [711–1923] |

~87 % of each module's functions — including everything in the ~400-function
floor beyond the first ~86 string/number helpers — are created *inside*
`bodies`, when some expression first demands them. The user/harness
function slots sit at index ~86–93, and the helpers follow in demand order,
interleaved with source-dependent types and globals.

**2. Common does not mean invariant.** 630 function names occur in all 36
rows, but:

- only **62** sit at the same function index in every row (the common prefix
  is exactly the string runtime; it breaks at index 62:
  `__str_to_number` vs `parseFloat`);
- only **83** have byte-identical final bodies. The rest differ in type,
  function and global indices, e.g. `__str_copy_tree` is `(type $147)` with
  a `(ref null $1)` param in one row and `(type $204)`/`(ref null $5)` in
  another;
- the common name+body prefix is **0** — even the first helper differs,
  because source-dependent type reservations (`reserveTypedArraySubviewTypes`,
  `reserveObjVecArrType`, `collectDynamicObjectReturnCarrierTypes`, …) run
  before it. Module state already diverges before `collectAllSourceImports`
  (types 19/20/21). After it, the modal state (86 funcs / 77 types /
  29 globals) is shared by only 22 of 36 rows.

So a snapshot that stays byte-identical to base can cover at most the ~86
functions emitted before `bodies`, and only for rows with the modal
fingerprint. Seeding the other ~400 floor functions from a snapshot means
emitting them up front in a fixed order. That changes every function, type
and global index, so every binary changes, which the acceptance forbids.

**3. The cost it could remove is small.** Timing from exact checkpoint
timestamps (36 rows, no profiler, ~60 s total):

| segment | time | share |
|---|---:|---:|
| start → before `collectAllSourceImports` | 3.28 s | 5.4 % |
| `collectAllSourceImports` (the only snapshot-safe window, scan included) | 2.18 s | 3.6 % |
| → before `bodies` | 2.26 s | 3.7 % |
| `bodies` + unlabelled post-body passes → before finalize | 24.10 s | 40 % |

CPU profile (`--cpu-prof`, same 40 rows, 65.1 s sampled): inclusive time
under all `ensure*`/`emit*` helper builders is **3.8–9.6 %**. That is a lower
bound, because deep codegen stacks truncate, but it is the same order. The
dominant self time is whole-module walks: `stack-balance` 5.8 %, `ir-inline`
5.7 %, `instruction-walk` 5.4 %, `call-arg-producers` 2.7 %, `fixups` 2.6 %,
`dead-elimination` 2.6 %, plus TypeScript 13.6 % and GC 9.7 %. Those walks
scale with the module's function count, and a snapshot does not shrink it,
because the cloned functions would still be walked by every finalize pass.
Lever 1 does shrink it. The pure data tables are already memoised per process
(`enumerateClassRanges` has `enumCache`; `generalCategorySpans` and
`ensureRyuTables` cache too), so they are one-time warm-up, not per-test cost.

**4. Entanglement.** A seedable snapshot would have to deep-clone not just
`mod` but the `CodegenContext` registries that index it: 534 declared
fields, of which 236 are `Map`/`Set` registries (`funcMap`,
`nativeStrHelpers`, type caches, …), before counting the inherited
interfaces. Any registry missed silently re-emits a helper or points at a
stale index.

### Narrower proposals

1. **Do lever 1 first.** It is the lever that removes the ~39 % dead
   functions from every whole-module pass, and those passes are where the time
   goes.
2. **A pre-`bodies` snapshot is not worth doing.** Even for the modal
   fingerprint it saves at most ~3.6 %, and it needs a fingerprint over every
   source-dependent reservation made before `collectAllSourceImports`, plus a
   deep clone of ~236 registries.
3. **A fixed runtime prelude only works if byte-identity is relaxed** to
   "validates + test262/equivalence verdicts identical". Then the always-used
   helpers could be emitted up front from a per-process relocatable cache.
   The ceiling is helper-construction time (≈4–10 %), and it overlaps with
   lever 1 (the sweep deletes the unused ones anyway). Re-measure only after
   lever 1 lands.
4. **Candidate lever 3: TypeScript front end.** TypeScript is 13.6 % of
   compile CPU. The harness include set is re-parsed and re-checked for every
   test. That is the largest per-test invariant left that could stay
   byte-identical, since it is input processing, not emission order. It needs
   its own measurement first: the harness is currently concatenated into a
   single `test.js`, so prefix `SourceFile` reuse is not a drop-in change.
## Lever 1 implementation

Branch `issue-6768-dce-sweep` (base `0dbe04213b` = main `54a85ebdda` + this
file). New module `src/codegen/function-reachability-sweep.ts`; hooks in
`eliminateDeadImports` (`src/codegen/dead-elimination.ts`, via
`eliminateDeadLayoutAndPlanProgramAbi`) and two driver lines per pipeline in
`src/codegen/index.ts`. Standalone target only (`ctx.standalone && !ctx.wasi`);
`JS2WASM_FUNC_SWEEP=0` disables, `=1` forces it on for host/WASI too.

### What it does — stub, do not remove

Unreachable defined functions get their body replaced by a single
`unreachable` and their locals dropped. **They stay in `mod.functions`.**

Why not physical removal: function identity lives in two handle regimes (live
absolute indices and stable ordinals via `mod.funcOrdinalToPosition`, #1916) and
in codegen side tables read after this point (`funcMap`, helper maps,
trampolines, the Program ABI registries and their publication).
`eliminateDeadImports`' remap already only handles the import-removal
direction, and `ctx.numImportFuncs` is not even updated by it. Stubbing keeps
every index space unchanged, so none of that can go stale. To keep the import
and type spaces identical too, the sweep runs INSIDE `eliminateDeadImports`,
after its reference scan (which still sees the original bodies) and before its
remap walk. So the binary differs from base only in the dead bodies, plus
whatever the finalize passes then do differently on less code (see risks).

A liveness the sweep misses fails loudly: the stub traps on `unreachable`. It
cannot produce an invalid module or a call to the wrong function.

### Roots and edges

- Roots: function exports, start, active element-segment entries, `call`/
  `ref.func` in element offsets and global inits, and the helpers a later
  finalize pass may add a fresh `call` to by name (`__box_number`,
  `__unbox_number`: stack-balance / cross-hierarchy coercion plans, fixups).
- Deliberately NOT roots: `mod.declaredFuncRefs` (a declarative segment only
  licenses `ref.func` and is re-derived from bodies) and the
  `WasmFunction.exported` flag (only an entry in `mod.exports` is callable;
  standalone deliberately removes host-bridge exports before DCE). Together
  these two were retaining 4,412 → 7,020 of the dead functions.
- Edges: every `funcIdx` (`call`, `return_call`, `ref.func`) over the emitter's
  child enumeration (body/then/else/catches/catchAll). Every `ref.func`
  target counts as callable. A type-directed refinement (a target runs only if a
  live `call_ref` of a compatible type exists) was built and measured: it
  stubbed **0** additional functions on the 40 rows, so it was dropped rather
  than carry its subtyping / iso-recursive-equality soundness burden.

### Two sweep points

1. Inside `finalize/dead-layout`, before the first finalize pass: stubs 7,020
   of 28,399 functions (24.7 %).
2. Right after `finalize/ir-inline` (`sweepAfterInline`): the inliner's
   single-caller rule leaves each inlined callee unreferenced. Brings the total
   to **11,041 / 28,399 (38.9 %)**, matching wasm-opt's 38.8 % dead.

Both points come after every body FILL pass, so no body that could still gain
calls is analysed early. `JS2WASM_FUNC_SWEEP_VERIFY=1` re-runs reachability
after the last finalize pass and throws if a stub became reachable. It was on
for the test262 run and the 40-row checks below: zero trips.

### Measurements (2026-09-30, 4-core container, 40-row seed-7 sample)

| metric | base | lever 1 | Δ |
|---|---:|---:|---:|
| functions with a real body (36 modules; 4 rows are early-error tests) | 28,399 | 17,358 | −38.9 % |
| instructions entering stack-balance | 7,037,593 | 5,465,983 | −22.3 % |
| raw binary bytes | 21,896,027 | 18,140,736 | −17.2 % |
| wasm-opt `--remove-unused-module-elements` survivors | 17,385 | 17,219 | stubs reachable per wasm-opt: **0** |
| `WebAssembly.validate` | 36/36 | 36/36 | |

The 39 % of dead functions hold only ~22 % of the instructions, because the
floor's dead part is mostly small helpers. That ~22 % caps what this lever can
save in the finalize passes.

Phase self-time, `JS2WASM_COMPILE_PROFILE=1`, one run each (ms, 40 rows):

| phase | base | lever 1 |
|---|---:|---:|
| finalize/ir-inline | 4,470 | 3,750 |
| finalize/dead-layout (includes sweep 1) | 3,123 | 3,310 |
| finalize/stack-balance (+ preflight) | 3,755 | 2,843 |
| finalize/cross-hierarchy-operands | 2,361 | 1,674 |
| emit-binary | 2,212 | 1,763 |
| finalize/peephole | 1,425 | 1,128 |
| finalize/extern-convert-any | 822 | 676 |
| finalize/repair-struct-types | 554 | 417 |
| finalize/function-sweep (sweep 2) | — | 669 |
| **finalize + emit** | **18,722** | **16,230 (−13.3 %)** |
| total | 57,711 | 53,459 (−7.4 %) |

Wall clock, no profiler, `prof.mts`, interleaved base/new rounds (ms):

| round | base | lever 1 |
|---|---:|---:|
| 1 | 53,657 | 50,631 |
| 2 | 50,445 | 49,667 |
| 3 | 50,215 | 50,385 |
| 4 | 50,766 | 49,045 |
| 5 | 50,871 | 49,759 |
| 6 | 49,476 | 49,638 |
| mean | 50,905 | 49,854 (**−2.1 %**) |

The profiled −7.4 % over-states the unprofiled gain. The honest number is the
~2 % wall-clock mean, with run-to-run noise of the same order. Sweep 2 is roughly
cost-neutral in time: with it disabled, total was 53,287 vs 53,459 profiled. It
is kept for the binary-size win, which also shows up downstream as test262
`exec_ms` −4.6 %.

### Correctness evidence

- **test262 standalone**, 2,673 tests (built-ins/Promise; language/expressions/
  async-arrow-function, async-function, async-generator; built-ins/Array/from
  and prototype/{map,filter,splice,concat,flat,flatMap,indexOf};
  built-ins/RegExp/prototype/exec and named-groups; language/statements/class/
  subclass and super; plus all 40 sample rows), base and new each run through
  `pnpm run test:262` with `TEST262_PATH_FILTER_FILE`. Per-test status is
  **identical on every row**: pass→pass 2,095, fail→fail 393, CE→CE 181,
  timeout→timeout 4. Zero pass→fail and zero fail→pass.
- `node scripts/equivalence-gate.mjs`: 22 failing = the 22 known baseline
  failures, **no new regressions**.
- Root vitest suite, standalone-compiling files, sweep on vs
  `JS2WASM_FUNC_SWEEP=0`: all 232 files that inspect WAT or function structure,
  plus a 101-file stride sample of the rest. Seven WAT-shape tests inspected
  the emitted body of a function that is dead in their test program — never
  called, or inlined away. Those opt out of the sweep, with a comment:
  1888, 3522, 3685 (one case), 3765, 4121,
  native-number-string-integer-fastpath, npm-compat-perf-native-add-fastpath.
  All other results matched base, including the files that time out or OOM in
  this container in both modes (4376, 4588, 6662, …).
- `tests/issue-6768-reachability-sweep.test.ts`: roots and edges (exports,
  elements, global inits, stable handles, shared arrays, late-pass helper
  roots, declared-ref-only and exported-flag-only functions stubbed), fresh
  arrays on stub (a shared body stays intact for its live owner), identical
  import/type layout with the sweep on and off, the verifier catching a late
  reference, and an end-to-end standalone compile/run with the sweep on and off.

### Risks / follow-ups

- **Late-pass references.** A finalize pass that adds a `call` to a
  by-name helper not in `LATE_PASS_HELPER_ROOTS` would hit a stub and trap. The
  audit found only `__box_number` / `__unbox_number`. The verifier env flag
  exists to catch a new one.
- **Finalize passes see less code, so they decide differently.** The main case
  is ir-inline, which counts call sites: dead callers no longer count. That
  changes some inlining decisions. It is semantics-preserving, but it is not
  byte-identical on live code. wasm-opt survivors went 17,385 → 17,219, and
  verdicts were unchanged.
- **Stubs still cost an entry each** (function and code section, name).
  Physical removal belongs at emit time: compact positions in `resolveLayout`
  once every post-codegen consumer reads indices through it.
- **Host mode is not enabled.** It looks equally sound (roots are the same;
  host funcref escapes all go through `ref.func`), but it was not validated
  here. Next step: a host test262 subset with `JS2WASM_FUNC_SWEEP=1`.
- **The bigger remaining cost sits before the sweep point.** `codegen` self
  time (42 %) and `module-init-pass1` (13 %) come before it, and dead helpers
  are cheap to walk. So lever 1's wall-clock ceiling is small. Lever 2
  (build the floor once per process) targets the larger part.
