---
id: 4404
title: "QuickJS bytecode to Wasm tiering: call-boundary promotion first, same-invocation OSR second"
status: backlog
sprint: Backlog
created: 2026-08-14
updated: 2026-08-14
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: performance
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 3630, 4238, 4242]
---

# #4404 — QuickJS bytecode to Wasm tiering with same-invocation OSR

## Request

Use the already-embedded QuickJS-NG parser/compiler as the front end for a
runtime AOT tier. Start executing dynamic source immediately in QuickJS, lower
its compiled bytecode to a Wasm side module in parallel, and eventually transfer
a still-running hot loop or function into that module without restarting the
eval call.

This is additive. It does **not** remove the native bytecode interpreter, the
Acorn-based native-WasmGC path, or the existing QuickJS provider. The first two
remain important when QuickJS's linear-memory heap and membrane are undesirable.

## Motivation and measured baseline

The checked-in runtime-eval comparison on an Apple M4 / Node 24.4.1 records:

| scenario | native interpreter | QuickJS-NG | current AOT POC |
| --- | ---: | ---: | ---: |
| cold process | 459.59 ms | 186.50 ms | 2.73 s |
| parse/compile every call | 93.64 ms | 1.19 ms | 17.58 ms |
| prepared execution | 103.92 ms | 745.47 us | 21.59 us |

The complete 93-sample record, source revisions, artifact hashes, and
methodology are in
`website/public/benchmarks/results/runtime-eval-engines.json`.

These numbers establish two different winners rather than predicting this
issue's outcome: QuickJS starts and compiles dynamic JavaScript quickly, while a
prepared side module executes the numeric workload much faster. The existing
AOT POC gets source through the full TypeScript-based js2wasm front end. If
QuickJS is already resident, parsing the same source again with Acorn or
TypeScript is unnecessary work.

## Proposed architecture

QuickJS does not expose an ESTree-style parser result. Its useful boundary is
the compiled QuickJS function/bytecode object:

```text
dynamic source
    |
    v
QuickJS compile-only parse -> QuickJS bytecode/function
    |                              |
    |                              +-> bytecode -> Wasm translator
    v                                             |
execute immediately in QuickJS                   v
                                      instantiate side module
                                                  |
                         call-boundary promotion, then loop OSR
```

Add a narrow shim API around QuickJS-NG's compile-only evaluation mode. The
shim should return an opaque rooted function handle and expose a versioned,
read-only bytecode metadata view suitable for translation. Do not pretend the
bytecode format is stable: the artifact already pins QuickJS-NG, and every
cache entry and translator result must include the exact QuickJS source revision
and bytecode-metadata ABI version.

The generated module is a **QuickJS tier**, not an ordinary js2wasm WasmGC
module. It should import QuickJS's linear memory and a small versioned runtime
helper namespace. QuickJS values that must remain visible to its garbage
collector stay rooted in QuickJS-owned frames or handles. Optimized numeric
regions may use unboxed Wasm locals only behind guards and only while their
boxed roots remain reconstructible.

## Phase 0 — prove and measure the interception point

Before building a translator:

- Add `qjs_compile`/`qjs_free_compiled` shim operations using compile-only mode.
- Demonstrate that syntax errors, directives, strictness, closures, and eval
  declaration behavior match the existing `qjs_eval` path.
- Enumerate the bytecodes used by a fixed corpus of representative eval
  sources. The tool must fail loudly when it cannot inspect a function; an
  empty opcode list is not a successful result.
- Measure parse+bytecode compilation separately from execution and provider
  startup. Record raw samples and exact artifact revisions.
- Decide whether to expose structured metadata directly from patched
  `quickjs.c` or decode serialized bytecode. Prefer a structured shim view if
  it avoids duplicating private serialization rules.

This phase may conclude that QuickJS's internal representation is too coupled
or too expensive to expose. That is a valid measured outcome, not a reason to
silently fall back to parsing the source a second time.

## Phase 1 — call-boundary tiering

Translate a complete supported QuickJS bytecode function to a side module and
use it on a **later invocation** of that function. This deliberately avoids
on-stack replacement while proving the representation, helper, cache, and
deoptimization contracts.

Initial supported subset:

- numeric and boolean constants;
- local loads/stores;
- arithmetic and comparisons;
- conditional/unconditional branches;
- bounded loops;
- return;
- no allocation, property access, closure mutation, exception region, or
  callback into arbitrary JavaScript in the first slice.

Unsupported bytecodes must retain the QuickJS function and report a structured
refusal reason. A translator must never replace a function with a partially
lowered or silently wrong module.

The side-module cache key includes:

- source/function identity and compile flags;
- exact QuickJS-NG revision;
- bytecode metadata ABI version;
- translator version and optimization policy;
- target engine/features.

## Phase 2 — same-invocation on-stack replacement (OSR)

Patch QuickJS's bytecode dispatch to expose explicit safepoints at supported
loop backedges. A hot loop requests compilation while QuickJS continues
executing. At a later safepoint, after the side module is ready, QuickJS
materializes the live state and enters a matching `resume` export:

```text
QuickJS frame + bytecode PC
          |
          | hot backedge -> request compile
          v
continue in QuickJS while compiler runs
          |
          | later safepoint sees READY
          v
materialize locals/stack/roots -> sideModule.resume(osrId, frame)
          |
          +-> finish normally
          +-> throw through the bridge
          +-> deopt: write state + resume QuickJS at an exact PC
```

`JS_SetInterruptHandler` may be useful for a diagnostic prototype, but it is
not itself a transparent OSR mechanism: interrupting evaluation produces an
abort/exception rather than a resumable frame. Production OSR needs an explicit
dispatch-loop patch and a versioned frame-state contract.

### Concurrency under both host families

Core Wasm cannot compile or instantiate another module by itself. Reuse the
portable host-capability direction proven by #3630:

- **JavaScript hosts:** compile on a Worker. Because synchronous QuickJS Wasm
  blocks ordinary message delivery, publish bytes/state through shared memory
  plus an atomic readiness word. At a safepoint, a narrow host capability may
  synchronously validate/instantiate the ready bytes and publish the entry.
- **Wasmtime/native hosts:** compile on a native thread and publish the same
  logical readiness/result record. Instantiate in the same Engine/Store policy
  required by the runtime.
- **No threads/shared memory:** remain on QuickJS for the current call and allow
  only Phase-1 promotion on a later call. This is an explicit capability
  fallback, not a failure.

Do not make the generated module dependent on JavaScript-only WebAssembly APIs.
The host capability must have equivalent JavaScript-host and Wasmtime
implementations.

## State, GC, exceptions, and deoptimization contracts

The implementation plan must freeze these before generalizing beyond a
non-allocating numeric loop:

1. **Frame map:** exact mapping from each OSR bytecode PC to QuickJS operand
   stack entries, locals, closure variables, `this`, and arguments.
2. **Root visibility:** no live QuickJS object may exist only in an untraced
   Wasm local across an allocation or helper call.
3. **Side-effect cutover:** the loop iteration containing the safepoint runs
   exactly once. Tests must detect duplicated and skipped writes.
4. **Guard failure:** the side module writes reconstructible boxed state and an
   exact resume PC before returning a deopt status.
5. **Exceptions:** thrown QuickJS values retain identity and handler selection;
   `try`/`finally` is out of the first OSR slice unless this is demonstrated.
6. **Cancellation/lifetime:** a context cannot be freed while compilation or a
   generated module still refers to its handles, memory, tables, or metadata.
7. **Reentrancy:** callbacks from optimized code into QuickJS cannot observe a
   half-materialized frame.

## Relationship to the other runtime-eval paths

- **Native interpreter (#2928):** retained as the zero-copy WasmGC value and
  environment tier. It can eventually have its own, simpler AOT promotion path
  because js2wasm controls its frame and value representation.
- **Acorn + all-dynamic IR (#3630):** retained as an independent js2wasm-native
  AOT design. It should not depend on QuickJS's heap or private bytecode ABI.
- **QuickJS provider (#4238/#4242):** this issue extends that provider
  internally. The frozen `js2wasm:runtime-eval` user-module seam should not
  change for the Phase-0/1 proof.

## Non-goals

- Replacing or deleting the native bytecode interpreter.
- Claiming a stable, version-independent QuickJS bytecode format.
- Passing QuickJS heap objects directly into the application's WasmGC heap.
- General JavaScript OSR in the first implementation slice.
- Changing the default engine before correctness and measured crossover gates
  pass.
- Counting successful module validation as semantic correctness.

## Acceptance criteria

### Phase 0: observable compiler boundary

- [ ] A pinned QuickJS artifact exposes compile-only and explicit lifetime
      operations with no new unsatisfied host imports.
- [ ] A positive-control corpus proves the compile-only path really ran and
      reports a non-zero opcode/metadata record for every accepted source.
- [ ] Compile-only syntax errors and strictness behavior match ordinary
      QuickJS evaluation on the same sources.
- [ ] Parse/bytecode compile, execution, and cold provider startup are measured
      separately with raw samples and exact revisions.

### Phase 1: later-call promotion

- [ ] At least one runtime-composed numeric-loop function executes first in
      QuickJS and a later invocation executes through a generated side module.
- [ ] Engine provenance is observable in-band or through exact counters; the
      test fails if every invocation stayed in QuickJS or every invocation used
      AOT from the start.
- [ ] Result and side effects match the pinned QuickJS control across all
      measured samples; denominator and wrong-result count are reported.
- [ ] Unsupported bytecode leaves the QuickJS function active with a
      structured refusal, never a partial module.
- [ ] JavaScript-host and Wasmtime implementations consume the same logical
      compile/instantiate capability contract.

### Phase 2: same-call OSR

- [ ] One long-running runtime-composed loop begins in QuickJS and completes
      the **same invocation** in the Wasm side module.
- [ ] Exact counters prove both tiers executed useful iterations in that one
      call, and a forced-not-ready control proves the instrument can distinguish
      no cutover.
- [ ] Cutover neither duplicates nor skips the safepoint iteration or its side
      effects.
- [ ] A forced guard failure reconstructs state and resumes QuickJS at the
      expected PC with the same final result.
- [ ] The supported subset survives GC stress without stale handles or missing
      roots; unsupported allocating shapes refuse OSR.
- [ ] Cold, promotion, steady-state, code-size, and memory-overhead measurements
      are recorded against unmodified QuickJS and the existing AOT POC.

## Expected implementation surfaces

- `scripts/quickjs-artifact/qjs_shim.c` — compile-only handles, metadata view,
  tiering/safepoint hooks, and pinned ABI version.
- pinned QuickJS-NG source patch applied by
  `scripts/quickjs-artifact/build.sh` — structured bytecode/frame access and
  later dispatch-loop OSR hooks.
- a new QuickJS-bytecode-to-Wasm translator and side-module cache.
- `scripts/quickjs-eval-provider.mjs` — tier selection, lifetime, provenance,
  and fallback plumbing behind the existing provider seam.
- `examples/runtime-eval-side-module/` — portable compiler/instantiate
  capability extended or factored for the QuickJS-oriented side module.
- focused unit, differential, GC-stress, deopt, JavaScript-host, and Wasmtime
  tests.

## Delivery order and sizing

Land Phase 0 and Phase 1 independently before specifying general OSR. A bounded
numeric Phase-1 proof is medium-to-large work; same-invocation OSR with frame
maps, GC rooting, guards, exceptions, and deoptimization is an XL VM project.
Every widening should be driven by a measured bytecode/opcode corpus rather
than an estimate of JavaScript feature coverage.
