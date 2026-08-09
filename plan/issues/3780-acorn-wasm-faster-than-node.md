---
id: 3780
title: "Compile Acorn parse hot path to Wasm faster than native Node"
status: in-progress
sprint: current
created: 2026-07-29
updated: 2026-08-09
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen, runtime, tooling
language_feature: strings, objects, arrays, classes, parser
goal: performance
assignee: "ttraenkler/codex"
depends_on: [3779]
related: [4157, 1710, 1712, 3756, 3920, 3921]
files:
  - .husky/pre-push
  - package.json
  - plan/issues/3780-acorn-wasm-faster-than-node.md
  - plan/issues/backlog/backlog.md
  - scripts/generate-npm-compat-report.mjs
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/expressions.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/fnctor-identity-fields.ts
  - src/codegen/fnctor-presence-bits.ts
  - src/codegen/interned-boolean-boxes.ts
  - src/codegen/member-get-dispatch.ts
  - src/codegen/member-set-dispatch.ts
  - src/codegen/object-runtime.ts
  - src/codegen/program-abi-signatures.ts
  - src/codegen/registry/imports.ts
  - src/codegen/struct-field-exports.ts
  - src/codegen/index.ts
  - src/codegen/native-regex.ts
  - src/codegen/declarations/declared-nested-write.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/object-ops.ts
  - src/codegen/property-access.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/regexp-standalone.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/typed-this.ts
  - src/compiler.ts
  - src/compiler/ground-call-fold.ts
  - src/ir/types.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/index.ts
  - src/optimize.ts
  - src/runtime.ts
  - tests/issue-1474-standalone-regex-refuse.test.ts
  - tests/issue-2063-switch-strict-equality.test.ts
  - tests/issue-3683-direct-calls.test.ts
  - tests/issue-3765-numeric-locals.test.ts
  - tests/issue-1712-exactfield-lane-guard.test.ts
  - tests/issue-3780-fast-leaf-host-imports.test.ts
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/compiler.ts
  - src/codegen/expressions.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/index.ts
  - src/codegen/native-regex.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/object-ops.ts
  - src/codegen/property-access.ts
  - src/codegen/regexp-standalone.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/typed-this.ts
  - src/index.ts
  - src/optimize.ts
  - src/runtime.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
oracle-ratchet-allow:
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/expressions/fnctor-prototype.ts
  - src/codegen/object-ops.ts
  - src/codegen/property-access.ts
  - src/codegen/statements/control-flow.ts
func-budget-allow:
  - src/runtime.ts::buildImports
  - scripts/generate-npm-compat-report.mjs::compileStandaloneLane
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/fnctor-escape-gate.ts::analyzeProtoMethodWriteOnce
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/native-regex.ts::ensureRegexSearch
  - src/codegen/object-ops.ts::compileObjectDefineProperties
  - src/codegen/regexp-standalone.ts::ensureDynamicStandaloneRegExpCompiler
  - src/codegen/statements/control-flow.ts::compileSwitchStatement
  - src/codegen/typed-this.ts::fillDirectCallTrampolines
  - src/codegen/typed-this.ts::recordDirectCallGeneric
  - src/codegen/typed-this.ts::tryEmitDirectTwinCall
  - src/compiler/ground-call-fold.ts::foldGroundCallsInMultiFiles
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/integration.ts::compileIrPathFunctions
origin: "user request to repeat the measured clsx and cookie optimization process for Acorn and beat native Node"
---

# #3780 — compile Acorn parse hot path to Wasm faster than native Node

## Product outcome

The real pinned `acorn@8.16.0` package is reported in two deliberately separate
performance contracts:

1. **Compile-time static / standalone:** the package, fixed source, options,
   operation, and test driver are all compiler-visible. Generic,
   semantics-preserving evaluation of this closed program is allowed.
2. **Runtime dynamic / JS host:** Node supplies the source and options after
   compilation and observes every call. The compiled parser must execute the
   operation for each runtime input.

Both use `optimize: 4`, the same pinned package operation, and the existing
two-warm-up/nine-measured-round protocol. No Acorn package, file, source-text,
export-name, or expected-output special case is permitted.

## Benchmark contract

Both sides receive the same test and verify checksum `422`, but the input
knowledge is part of the result and must never be combined. The static lane may
erase work only through a generic closed-program proof and measures the
result-preserving residual. The dynamic lane must parse and observe the same
source on every measured call. The static faster-than-Node goal is complete;
runtime-dynamic performance remains open.

## Investigation

Establish a fresh same-host baseline. Record optimized and correctness binary
sizes, Wasm imports and start shape, representative WAT, per-operation
Wasm-to-host imports and host callbacks, export marshalling, CPU attribution,
and compile/instantiate/first-call startup. Identify the host precisely and
report cold startup separately from the repeated-call hot benchmark.

## Measured baseline

Candidate base `6bf34f1099ea15` (current main plus #3778 and #3779), Node
24.4.1 / V8 13.6.233.10-node.17, arm64 macOS:

| lane           |           median | standard deviation |
| -------------- | ---------------: | -----------------: |
| compiled Wasm  | 1,323,300.108 µs |      22,041.787 µs |
| native Node    |     4,023.425 µs |         271.059 µs |
| Node advantage |          328.89x |                    |

The baseline used five iterations, two warm-up rounds, and nine measured
rounds. Correctness was 3,507/3,518 official Acorn tests (99.69%), matching the
pre-existing surface.

## Binary and execution analysis

The optimized performance module is a 330,903-byte WasmGC binary; the separate
correctness binary is 596,610 bytes. It has no linear memory. Its start function
initializes Acorn's token types, parser prototypes, accessor closures, regular
expressions, and lookup tables before exports are wired.

The optimized binary declares 77 function imports plus a large string-constant
global namespace. The WAT contains typed WasmGC structs for `Parser`, `Node`,
`TokenType`, `TokContext`, source locations, regexp validation state, arrays,
and many closure/functor shapes. Parser fields and generic operations repeatedly
move through `externref`, `f64`, boxed booleans/numbers, generic property
helpers, and closure dispatch. The public `parse` wrapper is small; the cost is
the recursive parser graph it enters.

An exact, allocation-free per-instance import counter measured one changed
source parse after module initialization:

| dynamic work group                                    | Wasm-to-host calls |
| ----------------------------------------------------- | -----------------: |
| numeric boxing/unboxing, type, truth, compare, index  |         11,032,750 |
| extern property reads/writes, lookup, method dispatch |          5,656,932 |
| arrays, argument vectors, and iteration               |            866,913 |
| object creation, registration, deletion               |             58,870 |
| regexp and string helpers                             |             54,500 |
| **total**                                             |     **17,669,965** |

The largest individual helpers are `__box_number` (2,995,053),
`__extern_get` (1,852,765), `__get_undefined` (1,718,875),
`__host_compare` (1,698,487), `__unbox_number` (1,564,754),
`__host_eq` (1,463,415), `__typeof_number` (1,321,348), and
`__is_truthy` (1,309,535). This direct census explains the flat
constant-factor cost more precisely than attributing the 1.323-second sample to
the compact public wrapper. Host-to-Wasm callbacks are not counted on the miss:
wrapping Acorn's callback exports changes its closure ABI. The counter therefore
reports that dimension as unavailable rather than a false zero.

## Who the host is

The host is Node 24.4.1. Its V8 engine instantiates the WasmGC binary through
the JavaScript `WebAssembly` API. JavaScript functions built by
`src/runtime.ts` satisfy the module's `env` imports, and V8 supplies the
`wasm:js-string` built-ins. Native Acorn and compiled Acorn run in the same V8
process. This is not WASI, Wasmtime, or a browser.

## Startup denominator

The final clean run separated build time from deployed startup:

| phase                                       |          time |
| ------------------------------------------- | ------------: |
| compile 226 KB JavaScript source at level 4 | 10,572.719 ms |
| `WebAssembly.compile` optimized binary      |      0.779 ms |
| instantiate, including Acorn module start   |      2.382 ms |
| wire runtime exports                        |      0.001 ms |
| wrap public exports                         |      0.110 ms |
| first parse                                 |  1,283.007 ms |
| second parse                                |  1,228.122 ms |

Source compilation is a build-time denominator, not deployed startup. If the
shared host runtime is not already loaded, #3778 measured another 199.559 ms to
load its unchanged 10,007,724-byte JavaScript chunk (1,663,408 bytes gzip).
This optimization does not shrink that runtime or the 330,903-byte Wasm module.
The first/new-source parse still performs the full parser and snapshot, so no
cold-start improvement is claimed.

## Benchmark setup

`pnpm run benchmark:acorn` runs only Acorn, retains the committed correctness
and performance implementations, prints all nine samples and diagnostics, and
does not update aggregate artifacts. `pnpm run benchmark:acorn:perf` skips the
correctness harness and official suite for iteration. `--diagnostics-only`,
`--inspect-boundaries`, and `--inspect-wat` isolate binary/startup, boundary,
and WAT attribution work.

Both lanes use one shared iteration count calibrated against the slower lane.
This changes only run duration; both lanes still execute the same count in
every round.

## Runtime-dynamic measurement

Both sides parse Acorn's same 226 KB distribution source and observe
`ast.body.length === 422` on every call:

| lane          |           median | standard deviation |
| ------------- | ---------------: | -----------------: |
| compiled Wasm | 1,241,301.500 µs |      10,285.913 µs |
| native Node   |     4,204.583 µs |         604.808 µs |

The nine-round result uses one full parse per round and puts Node
**295.23x ahead**. Matching checksum 422 is recorded in the committed artifact.
Correctness remains exactly 3,507/3,518 (99.69%).

## Standalone runtime-dynamic execution

The standalone runtime-dynamic driver receives a numeric seed only after
compilation, incorporates it into the source, runs the complete test loop
inside Wasm, and returns checksum `422`. Its 1,784,602-byte WasmGC module has
zero imports and does not use staged evaluation. Two generic codegen
improvements reduced the pre-driver representative parse from 76.98 ms to
65.49 ms:

- object-only switches compare WasmGC reference identity instead of executing
  the full JavaScript primitive/tag StrictEquality cascade for every case;
- runtime-constructed, flagless `^(?:literal|literal|...)$` regular expressions
  use a compact literal-alternative representation and direct matcher.

The committed runtime-input lane measures 71,248.30 us/op in Wasm versus
4,129.78 us/op in Node, leaving Node **17.25x faster**. The final profile
attributes 8.7% to internal `__extern_get`, 5.3% to regexp test dispatch, 3.6%
to generic one-argument function dispatch, 3.0% to `ToPrimitive`, 2.4% to
number unboxing, and only 1.1% to GC. The parser remains on the legacy backend;
`irCompiledFunctions` is empty.

### Runtime-dynamic optimization round

The follow-up compiler work remains package-agnostic and executes the same
runtime parse on both sides. Four generic changes reduce the representative
standalone median from 71.25 ms to 54.79 ms (23.1%):

1. A homogeneous numeric `switch` unboxes the discriminant once and emits
   ordered `f64.eq` comparisons. A runtime number guard preserves strict
   equality for strings, objects, `NaN`, and side-effecting case expressions.
2. Call-site ABI inference carries an existing grounded numeric-local proof
   into an otherwise `any` helper parameter. This removes repeated
   box/`ToPrimitive`/unbox work in helpers such as character classifiers
   without guessing from the helper body or specializing Acorn.
3. A write-once prototype method without a typed twin now retains its exact
   closure instance and calls the known lifted body directly. Captures remain
   live; the old dynamic dispatcher remains the pre-initialization fallback.
4. A generic lifted prototype body may devirtualize its own pinned `this.m()`
   calls behind a runtime receiver-shape guard. Detached or foreign receivers
   take the original dispatcher.

The direct-call diagnostics move from 1,886 sites / 264 trampolines / 14 legacy
fills to 3,980 sites / 547 trampolines / zero legacy fills: 518 trampolines call
typed twins and 29 call retained generic closures. The paired
`JS2WASM_PINNED_THIS_DIRECT_CALLS=0` control measures 58.22 ms, versus 54.31 ms
enabled, attributing about a 6.7% improvement to the fourth change alone.

Final official nine-round run (checksum 422):

| lane                               |          median |
| ---------------------------------- | --------------: |
| standalone runtime-dynamic Wasm    |   54,792.653 us |
| native Node                        |    3,905.500 us |
| remaining Node advantage           |      **14.03x** |
| optimized binary / runtime imports | 1,775,322 B / 0 |

The separate named-profile run measures 54,169.951 us in Wasm versus
4,047.042 us in Node. Its 1,816,942-byte binary only differs by preserved debug
names. The largest exclusive buckets are `__extern_get` (11.2%), runtime RegExp
`.test` dispatch (6.5%), GC (4.0%), `ToPrimitive` (2.0%), and `Node`
construction (2.3%). Generic one-argument closure dispatch falls from 4.0%
before the pinned route to 1.0%. A speculative call-site RegExp brand split was
removed after its paired control showed it was about 2% slower; no non-winning
experiment remains in the patch.

The dynamic parser is still emitted by the legacy WasmGC backend
(`benchmarkUsesIr: false`, empty `irCompiledFunctions`). The zero-import module
has no host crossings during the parse—the remaining 14.03x gap is internal
Wasm object/string/regexp representation and dispatch cost, not 17.67 million
Node callbacks. Beating Node remains the open acceptance criterion; the static
IR residual is reported separately and does not satisfy it.

### Runtime-dynamic optimization round 2

Four further package-independent lowerings keep the exact runtime-suffixed
226 KB input and checksum:

1. A switch whose case values are numeric and whose discriminant already has a
   proven `f64` local/parameter slot uses that slot directly. It no longer
   boxes, runtime-type-tests, and unboxes the same value before the existing
   ordered numeric comparisons. The proof, not the checker-visible `any`, is
   the admission gate.
2. A typed-this twin now uses its typed receiver parameter for bare/non-field
   `this` expressions as well as field accesses. Direct twin trampolines can
   therefore omit the ambient `__current_this` save/install/restore frame when
   the trampoline is twin-exclusive. Guarded trampolines retain the frame
   because their legacy miss arm still observes the ambient receiver.
3. Direct methods that have neither `arguments` (already an admission refusal)
   nor parameter initializers cannot observe `__argc`. Their trampolines omit
   its enter/leave writes; methods with defaults retain the old protocol.
   Eighty paired parses measure a further 1.72% median / 1.63% mean win.
4. The native RegExp `.test` carrier is representation-disjoint from every user
   closed struct. Its brand arm is now the outermost `test/1` dispatch branch,
   avoiding the generated user-method ladder on Acorn tokenizer regexps.
   Eighty paired parses measure a further 2.58% median / 2.68% mean win.

The final named-profile run measures 48,970.208 us/op in Wasm versus
4,406.141 us/op in Node, with checksum 422, zero imports, and a 1,807,229-byte
debug-name-preserving binary. This is 9.6% faster than the prior named run but
still leaves Node **11.11x faster**. The regenerated ordinary artifact run
measures 50,113.993 us/op versus 4,424.375 us/op (Node 11.33x faster) with a
1,765,609-byte stripped binary. The largest exclusive buckets are generic
`__extern_get` (11.89%), RegExp test/engine work attributed to
`__call_m_test_1` (8.33%), `__closure_378__typed_this` (3.23%),
`__closure_543` (2.63%), `ToPrimitive` (2.55%), and GC (2.38%). The full
Acorn gate remains 3,507/3,518 official tests.

Three plausible changes were measured and removed: pooled two-slot RegExp
capture arrays regressed about 1%, restricting the generic property cache to
plain objects was neutral, and Wasm tail calls on the typed branch regressed
about 0.6%. No failed experiment remains in production code.

The exact runtime-dynamic driver still emits zero IR functions. With
`JS2WASM_IR_SHAPE_DIAG=1`, the migration handoff sees 43 reachable functions:
19 body-shape refusals, 17 unresolved parameter types, three unsupported
logical values, two dynamic RegExp constructors, one constructor-identity
case, and one derivative call-graph-closure refusal. Because selection is
call-graph closed, the runtime parser cannot partially enter IR until those
producer/value/shape blockers are cleared; this direct-backend round is the
performance baseline the IR path must preserve.

### Runtime-dynamic optimization round 3

Binary inspection showed that the remaining property cost was not one uniform
`__extern_get` problem. Two redundant representation decisions dominated:

1. Acorn's fixed `types$1` token table was opened merely because code later
   writes declared fields on the `TokenType` instances stored inside it. The
   root table does not grow. The compiler now follows assignment-returning
   constructor factories and keeps the outer literal closed when the nested
   write targets a field declared by that constructor (or by a nested literal).
   The descriptor-table case remains open when the nested field is genuinely
   new. With `JS2WASM_KEEP_CLOSED_NESTED_TABLES=0` restoring the old policy, the
   paired medians are 53,619.507 us old versus 48,703.292 us enabled
   (**9.17% faster**) and the binary is 64,792 bytes smaller.
2. `Parser.options` is intentionally an open `$Object` populated by `getOptions`
   through computed keys. Hot reads such as `this.options.ecmaVersion` and
   `parser.options.locations` nevertheless emitted a closed-struct candidate
   ladder at the call site before reaching the canonical dynamic getter. Fnctor
   field metadata now preserves the open-object provenance and routes those
   nested reads directly to `__extern_get`. This does not replace or bypass the
   generic property cache; it reaches that cache earlier and retains its native
   struct, prototype, accessor, null, and mutable-field fallbacks. With
   `JS2WASM_TYPED_OPEN_CARRIER_READS=0` restoring the old call-site ladder, the
   final paired medians are 50,532.278 us old versus 48,213.417 us enabled
   (**4.59% faster**) and the binary is 10,659 bytes smaller.

The optimized half of the final paired run returns checksum 422, has zero
imports, and measures 48,213.417 us/op versus 4,752.673 us/op in Node. Node
remains **10.14x faster**; the stripped Wasm binary is 1,690,158 bytes. After
rebasing onto the current IR-adoption stack, the regenerated full npm-compat
artifact measures 46,687.179 us/op versus 4,832.476 us/op (Node **9.66x
faster**) with a 1,677,262-byte binary and the same checksum. An intermediate
debug-named profile after the first open-carrier stage attributes 8.70%
exclusively to `__extern_get`, 6.00% to RegExp test/engine work, 4.12% to GC,
2.94% to `ToPrimitive`, and 2.55% to `Node` construction. The selected
`Node_new` WAT confirmed four repeated `parser.options.locations/ranges`
type-ladder sequences per constructed AST node; the second change removes their
outer options-object ladders.

Correctness remains 3,507/3,518 on Acorn 8.16.0's pinned official suite. The
benchmark still compiles the test loop into Wasm, supplies the source selector
after compilation, performs every parse, and crosses no host boundary. Its
top-level benchmark/parser driver remains direct (`benchmarkUsesIr: false`),
while 15 reachable character/RegExp helpers are now IR-emitted. These
representation wins apply to the direct parser path and remain parity
requirements as the rest of that call graph migrates to IR.

### Runtime-dynamic optimization round 4 — allocation volume

**Different box, so read the deltas and not the absolute times.** Rounds 1-3
were taken on Node 24.4.1 / arm64 macOS. This round is a 4-core / 16 GB Linux
container on **Node 22.22.2**, where the profile is not the same shape: a
debug-named 30-parse profile attributes **36.7%** of the standalone parse to
`(garbage collector)`, against the 4.3% and 1.5% the two round-3-era profiles
recorded. Cross-machine wall-clock is not comparable and no comparison against
a committed baseline is made here. What IS comparable — and is what this round
is argued on — are **same-process paired A/B measurements** and the
**deterministic allocation counters**, both taken on one box within minutes of
each other.

The lever this exposes is allocation *volume*, which nothing in rounds 1-3
measured. Summing inter-GC heap growth from `--trace-gc` over 12 parses:
the standalone module allocates **58.0 MB per parse of the 226 KB source**,
about 257 bytes for every source byte. Only ~10 MB of that is the AST it
returns (32,487 `Node` structs plus 4,275 arrays and 126 KB of token strings,
counted from native acorn) — the rest is transient.

Two package-independent lowerings cut it. Both are behaviour-preserving
representation changes, neither is specific to acorn, and each ships with a
paired control so the attribution is measured rather than argued:

1. **Packed own-property presence flags** (`JS2WASM_PACKED_PRESENCE_BITS=0`).
   #2847 gives every conditionally-assigned fnctor property a hidden
   `$has_<name>` slot so an untouched default stays distinguishable from an
   explicit `null`/`0`. One whole `i32` per tracked property is correct but is
   paid on every instance: acorn's `Node` carries 63 tracked properties, so the
   flags alone were 252 bytes of a 536-byte AST node. They now live in
   `$presence_<w>` bit words — `Node` goes from **130 fields / 536 B to 69
   fields / 292 B**. The control strides the bit assignment by a full word so
   each flag lands alone in its own slot, which reproduces the old footprint
   through the identical read/write lowering; the A/B therefore isolates the
   layout, not the instruction mix.
2. **Interned boolean carriers** (`JS2WASM_INTERNED_BOOL_BOXES=0`). A JS
   boolean is a primitive with no observable identity, the carrier's `value`
   field is already immutable, and every consumer discriminates it by
   `ref.test`/`struct.get` rather than by reference — so the program needs
   exactly two carriers, built in the global init. `__box_boolean` collapses to
   a `global.get`. It is inlined by `wasm-opt` into **742 static `struct.new`
   sites**, the hottest being the boolean arms of `__extern_get`'s
   closed-struct field ladder, so this fires per boolean-typed property read.

Allocation per parse, one binary per process, 12 parses each (deterministic —
this metric does not move with box load):

| build | allocated / parse | vs baseline |
| --- | ---: | ---: |
| baseline (both controls off) | 58.0 MB | — |
| packed presence only | 50.0 MB | −13.8% |
| interned booleans only | 52.0 MB | −10.3% |
| **both** | **43.6 MB** | **−24.8%** |

The two are additive to within 0.4 MB (58.0 − 8.0 − 6.0 = 44.0 measured 43.6),
which is the cross-check that they are independent effects and not one effect
counted twice. The 6.0 MB boolean figure implies roughly 375,000 boolean boxes
per parse at 16 B each.

Wall clock, all four builds instantiated in **one process** and run in rotating
order for 45 rounds so contention drift hits every variant alike:

| build | min | p25 | median |
| --- | ---: | ---: | ---: |
| baseline | 109.8 ms | 119.1 ms | 125.6 ms |
| packed presence only | 106.5 ms | 114.7 ms | 122.9 ms |
| interned booleans only | 111.2 ms | 116.4 ms | 124.2 ms |
| **both** | **103.9 ms** | **111.6 ms** | **116.3 ms** |

Combined: **−5.4% min / −6.3% p25 / −7.4% median**. The single-lowering rows
are inside the run-to-run noise of each other and are quoted only as directions;
the combined row is the one that is separated from baseline in every statistic,
and it agrees with the independent `--trace-gc` accounting (GC 30.1 → 22.5 ms
per parse on a separate paired run, i.e. ≈7.6 ms of a ≈120 ms parse).

Cost: the stripped binary grows **1,670,971 → 1,673,257 bytes (+0.14%)** — the
struct loses 61 fields but each presence test gains a mask-and-compare. The
`__npmCompatStandaloneBenchmark` export still returns checksum **422** with
**zero imports**, and the pinned official Acorn suite is unchanged at
**3,507/3,518 (99.69%)**.

**This does not close the gap and is not claimed to.** On this box the same
paired protocol leaves Node roughly an order of magnitude ahead; the honest
reading is that ~24.8% less allocation buys ~7%, and that **34 MB of the
remaining 43.6 MB per parse is still transient garbage that the returned AST
does not account for** — about 810 bytes per token. Locating it needs a
per-type allocation census, which this round did not build: V8's sampling heap
profiler does not attribute WasmGC `struct.new` (measured: 0.2 MB of a 58 MB
parse sampled), and `--trace-gc-object-stats` is unavailable on this Node. That
census is the recommended next step, ahead of another micro-lowering, and is
filed as **#3921**. The standalone-only `in`-over-a-fnctor-instance divergence
that surfaced while writing this round's regression test is filed separately as
**#3920** — it reproduces with both lowerings disabled and is not round 4's.

## Compile-time static outcome

For the reported static row, compilation first builds the full zero-import
module above, initializes it, and evaluates the exact exported operation once
inside Wasm. That stage produces `422` without using Node as an oracle. The
generic benchmark tooling then compiles the equivalent result-preserving
residual; Node independently performs the same parse operation and the normal
checksum comparison still guards the result.

This is staged evaluation, not memoization: there is no result cache, lookup, or
runtime input key. It applies to a closed numeric operation regardless of
package and refuses a stage with host imports or a non-finite result. The final
20,874-byte module has zero imports and
`__npmCompatStandaloneBenchmark` is emitted by the IR backend.

Committed nine-round measurement on Node 24.4.1 / V8 13.6, arm64 macOS:

| lane                              |          median |
| --------------------------------- | --------------: |
| standalone static residual Wasm   |      0.02473 us |
| native Node parse                 |  4,658.36980 us |
| Wasm residual advantage           |  **188,335.9x** |
| full Wasm static-evaluation stage |       421.46 ms |
| full stage binary / imports       | 1,784,473 B / 0 |

The static ratio is real for deployment when those inputs are compile-time
constants, but it is not a claim that Acorn parses a new source faster than
Node. That claim belongs exclusively to the runtime-dynamic row.

The committed JS-host runtime-dynamic row measures 1,241,301.50 us/op in Wasm
versus 4,204.58 us/op in Node, leaving Node approximately **295.23x faster**.
Its 330,903-byte binary retains 77 function imports, and one identical parse
crosses from Wasm to the Node host about 17.67 million times. The largest
families are number boxing/unboxing, host comparison/truthiness, and generic
extern property access. Those calls—not startup—dominate this lane.

An explicit result-floor diagnostic changed the compiled export to consume
`.body.length` inside Wasm and return only the number. It still made 17,669,415
Wasm-to-host calls and measured 1.23 s/op, effectively identical to returning
the public parse result and observing it in Node. The 17.67 million calls
therefore occur inside the single parser invocation; they are not repeated
parser calls or AST-result marshalling.

## Acceptance criteria

- [x] `pnpm run benchmark:acorn` runs only Acorn, uses the official npm-compat
      correctness and performance implementations, prints raw samples, and does
      not overwrite aggregate artifacts.
- [x] The dynamic benchmark invokes parameterized public
      `parse(source, options)` on every call; no package/source/file/export-name
      special case is introduced.
- [x] The static benchmark reports its compiler-visible input knowledge,
      performs generic staged evaluation only in a zero-import Wasm module, and
      records the full evaluation-stage time and binary separately.
- [x] The standalone runtime-dynamic benchmark receives an input-selecting
      value after compilation, keeps the test loop and observation inside
      zero-import Wasm, and performs every parse.
- [x] The representative compiled AST remains equivalent to native Acorn, and
      the official correctness surface does not regress.
- [x] Across the official static nine measured rounds, compiled Wasm residual
      median time is lower than native Node (`nodeUs / wasmUs > 1`).
- [ ] Across either official runtime-dynamic nine-round lane, compiled Wasm
      median time is lower than native Node (`nodeUs / wasmUs > 1`).
- [x] Baseline, final medians, standard deviations, iteration count, engine,
      binary size, imports, boundary census, CPU attribution, and startup
      denominator are documented.

## 2026-08-01 gap decomposition — where the remaining distance lives

Re-measured on current `main` (`eb9c2d7b5`), Node 22.22.2 / x64 Linux
container, same 226 KB corpus and the same `body.length === 422` observation.
The earlier sections above were taken on Node 24 / arm64 macOS at 295-328x; the
gap has closed by roughly 30x since, so the ranking below supersedes them.
Absolute figures are not comparable across the two boxes — see the cross-box
caveat on #3684/#3685/#3686.

### The honest lane is 9.6x, not 295x

| lane (`pnpm run benchmark:acorn:perf`) |    wasm median |   node median |          ratio |
| -------------------------------------- | -------------: | ------------: | -------------: |
| standalone, runtime-dynamic            |    132.1 ms/op |   13.8 ms/op  |     **0.104x** |
| js-host, runtime-dynamic               |  3,531.3 ms/op |   11.0 ms/op  |       0.0031x  |
| standalone, compile-time-static        |     0.107 µs   |   11.1 ms     |   104,091x     |

Only the first row is a like-for-like throughput comparison. The static lane
folds the whole parse at compile time and measures a residual, and the js-host
lane is a different problem — every operation crosses into JS, so it is a
boundary-cost measurement, not a codegen one. **All analysis below uses the
standalone runtime-dynamic lane: 9.6x behind Node.**

### Binary structure — 1,702,365 bytes, and half of it is string data

| section  |     bytes |  share | count |
| -------- | --------: | -----: | ----: |
| Global   |   867,943 |  51.0% | 2,177 |
| Code     |   811,714 |  47.7% | 1,895 |
| Export   |    16,336 |   1.0% |   802 |
| Type     |     3,304 |   0.2% |   315 |
| Function |     2,263 |   0.1% | 1,895 |
| Elem     |       752 |   0.0% |    18 |

There is **no Data section**. Every string literal is materialized as a global
holding `array.new_fixed $3 <n>` with **one `i32.const` per UTF-16 code unit** —
1,915 such globals, and ~304,000 of the module's 327,120 `i32.const`
occurrences live outside function bodies. A passive data segment plus
`array.new_data` would encode the same constants at roughly one byte per
character instead of two to five, and would let the engine copy them rather
than run 304,000 constant expressions at instantiation.

That instantiation cost is measurable:

| phase                       |  time |
| --------------------------- | ----: |
| `WebAssembly.compile`       | 11.1 ms |
| `WebAssembly.instantiate`   | 13.8 ms |
| `__module_init()`           | 11.3 ms |
| **total to first parse**    | **36.2 ms** |
| (`import acorn` in Node)    | 11.8 ms |

Startup is 3x Node's and one full parse's worth of time. The 13.8 ms
instantiate is the eager global initializers; it is not steady-state cost, but
it is the whole cold-start budget.

### Code shape — a quarter of the code is duplicated twins

| name pattern              | fns |    lines | share of body text |
| ------------------------- | --: | -------: | -----------------: |
| `$__closure_N`            | 313 |  293,485 |              46.5% |
| `$__closure_N__typed_this`| 236 |  162,779 |          **25.8%** |
| `$__call_fn_method_N`     |   9 |   34,840 |               5.5% |
| `$getOptions`             |   1 |   15,271 |               2.4% |
| `$__extern_get`           |   1 |   14,035 |               2.2% |
| `$__module_init`          |   1 |   12,562 |               2.0% |

The `__typed_this` twins (#3683/#3685) are a quarter of all emitted code. They
buy proven receiver field access on the typed path, but they are whole-body
duplicates — pure i-cache and binary-size cost on every call that does not take
the typed path.

### Whole-module opcode mix — two type checks per call

| opcode group                                        |  static count |
| --------------------------------------------------- | ------------: |
| `ref.test` + `ref.cast` + `ref.is_null`             |    **42,930** |
| `extern.convert_any` + `any.convert_extern`         |    **24,288** |
| `call` (direct)                                     |        22,003 |
| `struct.get` / `struct.set`                         |        11,513 |
| `struct.new` + `array.new*`                         |         7,873 |
| `call_ref`                                          |         1,788 |
| `call_indirect`                                     |             0 |

The module performs about **two runtime type discriminations per call site**
and more representation conversions than it has calls. Meanwhile `call_ref` is
7.5% of call sites and `call_indirect` is zero — **dispatch is not where the
time is**, consistent with the earlier 3.87% dynamic dispatch-family figure.

Most-called helpers by static call-site count: `__box_number` 2,250,
`__unbox_number` 2,157, `__str_flatten` 1,834, `__str_equals` 1,370,
`__to_bigint` 992, `__extern_is_nullish` 869, `__is_truthy` 854,
`__extern_get` 673.

### CPU profile — 38% of runtime is helpers that exist because a type wasn't proven

Self time, 6,746 samples at 150 µs, named standalone binary:

| category                          | self |
| --------------------------------- | ---: |
| compiled acorn code               | 41.4% |
| **GC**                            | **17.4%** |
| extern / dynamic property + eq    | 10.4% |
| dynamic dispatch                  |  7.6% |
| regexp runtime                    |  5.2% |
| any boxing / coercion             |  4.9% |
| object construction (fnctor)      |  3.9% |
| JS host / node startup            |  3.2% |
| other runtime                     |  2.8% |
| string runtime                    |  1.7% |
| object model                      |  1.0% |
| argvec / vec helpers              |  0.5% |
| **runtime helpers, non-GC**       | **38.0%** |

Largest single frames: `__extern_get` 5.6%, `__regex_search` 4.1%,
`__fnctor_Node_new` 3.4%, `__extern_strict_eq` 2.7%.

### `__extern_get` is a 303-way linear string scan

The single hottest helper is one function of 14,035 WAT lines containing
**1,080 `if`s, 463 `ref.test`, 457 `ref.cast`, 535 `struct.get`, 376 calls and
303 `__str_equals`** — with **zero `br_table`**. Every dynamic property read
walks a linear chain: up to 463 type tests to identify the receiver's concrete
shape, then up to 303 string comparisons to identify the key. That is why 673
static call sites cost 5.6% of self time. Perfect-hashing the key and
`br_table`-dispatching the receiver shape is the single most concentrated lever
visible in the binary (#3926).

### Inside the parser's own hot code, a fifth of the instructions are tax

Instruction mix across the 12 hottest compiled-acorn functions (10,608 ops):

| category                | share |
| ----------------------- | ----: |
| local / global traffic  | 37.8% |
| arithmetic + constants  | 19.3% |
| **type discrimination** | **11.8%** |
| control flow            | 11.7% |
| **rep conversion**      | **8.1%** |
| call                    |  6.7% |
| field access            |  4.1% |
| allocation              |  0.5% |

Even in code compiled natively, **19.9% of instructions are `ref.test` /
`ref.cast` / `extern.convert_any` / `any.convert_extern`** — while actual field
access, the work of reading parser state and writing AST nodes, is 4.1%. The
37.8% local/global traffic is largely the spill pressure the tagged
representation forces.

### Allocation — 8.6x Node's volume

Bytes allocated per parse, from `--trace-gc` inter-collection deltas:

| runtime | allocated per parse |
| ------- | ------------------: |
| wasm    |          **43.9 MB** |
| node    |             5.1 MB  |

This corroborates the #3921 census (647,346 allocations per parse, of which
`$AnyValue` boxes are 47.96%) and explains the 17.4% GC bucket directly. Note
`__str_flatten` at 1,834 static call sites: rope flattening is a second
allocation source the census did not separate out.

### Conclusion — the gap is representation, not dispatch and not the allocator

Adding the independent measurements: 38.0% runtime helpers + 17.4% GC + 19.9%
of the 41.4% parser body (8.2%) ≈ **63% of execution is representation
overhead** — work that exists only because a value's type or a callee's
identity was not proven at compile time. Eliminating all of it is an upper
bound of ~2.7x, taking 9.6x behind to roughly 3.5x behind. Proving types is
therefore necessary but not sufficient; the residual 3.5x is the compiled
parser losing to V8's JIT on the same algorithm.

Three things this decomposition rules out as levers, each already measured:

- **The allocator.** Heap2Local promotes zero sites under `-O3 --closed-world
  --gufa`; sharing the zero-arity argvec removed 0.13% of allocations; sharing
  the empty backing store removed 1.4% (#3921/#3933). Allocation volume is not
  reachable by making allocation cheaper — only by not allocating.
- **Devirtualization for its own sake.** `call_ref` is 7.5% of call sites,
  `call_indirect` is zero, and the dispatch family is 3.87% of parse self-time
  across ~345 dispatchers with none above 0.08%. Devirtualization pays through
  the *boxing and widening it lets you avoid*, not through call cost.
- **Binary size and startup.** The 51% global section and the 25.8% typed-this
  duplication are real (36 ms cold start vs Node's 11.8 ms, 1.7 MB module), but
  they are cold-start and footprint problems and cannot move the 9.6x
  steady-state ratio.

Ranked by measured share, the remaining work is:

1. `__extern_get` / the extern family — 10.4% self, in one linear-scan function
   with an obvious algorithmic fix (#3926).
2. `$AnyValue` boxing — 48% of allocations, driving the 17.4% GC bucket and the
   8.1% in-body conversion tax (#3685 and successors).
3. The 11.8% in-body `ref.test`/`ref.cast` — proven receivers and proven fields
   remove these at the same time as (2).
4. `__regex_search` at 4.1% and `__fnctor_Node_new` at 3.4% — narrower, but
   both are single functions on the hot path.
5. String-literal globals → passive data segment; twin de-duplication. Halves
   the binary and the cold start, moves the steady state by nothing.

Reproduction: `.tmp/wat-census.mjs`, `.tmp/wat-funcs2.mjs`, `.tmp/hot-mix.mjs`,
`.tmp/prof-buckets.mjs`, `.tmp/alloc-rate.mjs`, `.tmp/startup.mjs` against a
WAT dump and the named standalone binary.

## 2026-08-09 JS-host leaf-import checkpoint

Current `main` (`517aa2d0debef17373eeadf36d42a775e4c6ddce`) still reports
Acorn JS-host runtime-dynamic as the largest uncovered running npm gap. One
parse makes 15,065,637 Wasm-to-host calls. The following proven leaf imports
account for 5,702,030 of them (37.85%):

| import | calls per parse |
| --- | ---: |
| `__get_undefined` | 1,753,050 |
| `__typeof_number` | 1,321,342 |
| `__is_truthy` | 1,310,240 |
| `__box_number` | 772,126 |
| `__box_boolean` | 545,250 |
| `__typeof_string` | 22 |

These operations only return `undefined`, apply `typeof`/ToBoolean, or return
an identity/boolean box. They cannot throw, call user code, or re-enter Wasm.
`buildImports` now gives zero- and one-argument imports with those safe intents
a fixed-arity leaf wrapper instead of the general recursion-depth and
`try`/`catch`/`finally` wrapper. The safety decision uses the closed import
**intent**, not a caller-supplied name. Import counting remains enabled in the
fast wrapper, and `JS2WASM_FAST_LEAF_HOST_IMPORTS=0` restores the guarded path.

The performance comparison used one prebuilt artifact for both sides, fresh
Node/tsx processes, one warm-up parse and one measured parse per process, eight
alternating-order pairs, and checksum `422` on every sample. The only variable
was the runtime kill switch:

| runtime | median | mean |
| --- | ---: | ---: |
| guarded base (`=0`) | 1,618,772.167 us | 1,692,400.771 us |
| leaf wrappers (`=1`) | 1,478,630.521 us | 1,554,253.896 us |
| improvement | **1.095x / 8.66% less time** | **1.089x / 8.16% less time** |

The process-level lane was noisy, including outliers on both sides; alternating
fresh processes and reporting both median and mean keep the comparison paired.
The exact samples, in pair order, were:

- guarded: `1423286.125, 1702635.083, 1587498.625, 1356205.291,
  1285319.708, 2505275.125, 1650045.708, 2028940.500` us;
- leaf: `1616879.958, 1628955.959, 1413372.459, 2334727.958,
  1278800.458, 1204033.333, 1470799.000, 1486462.042` us.

This is a runtime-only change. A pristine rebuild before and after produced the
same 347,063-byte binary and metadata, with SHA-256
`3b256b8f371f9f05aa9c9d7af84920058ed736567dacf5521f1992a2400002c0`.
The official nine-round harness also returned checksum `422`; appending a new
top-level declaration after compilation returned checksum `423`, proving that
the runtime source is still parsed rather than folded or memoized. Boundary
count is unchanged; this checkpoint only reduces JS wrapper cost.

Two broader ways to remove `__get_undefined` crossings were rejected and fully
removed: a lazy Wasm cache regressed the paired median by about 10%, and an
imported immutable externref global regressed it by about 14%. The remaining
Acorn gap is still dominated by generic compare/equality, numeric coercion, and
extern property operations; this checkpoint does not claim parity with Node.
