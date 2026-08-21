---
id: 4376
title: "Spike v8x as a rusty_v8-compatible js2wasm backend for a compiler-free Deno runtime"
status: in-review
created: 2026-08-12
updated: 2026-08-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+architecture
area: host-interop, runtime, deno
language_feature: modules, typescript
goal: deno-runtime
sprint: current
assignee: ttraenkler/codex-v8x-js2wasm
horizon: xl
related: [1584, 1662, 1772, 2525, 2658, 2928, 2997, 3571, 4377, 4378, 4380]
origin: "Project-lead request to determine whether js2wasm can run behind v8x and preserve Deno APIs without V8, JSC, or QuickJS"
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/statements/loops.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/emit/binary.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/index.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/literals.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/expressions/calls.ts
  - src/ir/lower.ts
  - src/codegen/expressions.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/class-bodies.ts
  - src/codegen/closures.ts
  - src/codegen/property-access-dispatch.ts
  - src/ir/integration.ts
  - src/codegen/stack-balance.ts
  - src/codegen/builtin-value-read.ts
func-budget-allow:
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/statements/exceptions.ts::compileTryStatement
  - src/emit/object.ts::encodeInstrWithReloc
  - src/codegen/statements/loops.ts::compileForOfIterator
  - src/emit/binary.ts::encodeInstr
  - src/codegen/statements/loops.ts::compileForOfDirectIterator
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/property-access-dispatch.ts::tryBufferViewAttributeReads
  - src/ir/integration.ts::makeResolver
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/declarations/object-shape-widening.ts::scanStatements#2
oracle-ratchet-allow:
  - src/codegen/builtin-static-globals.ts
  - src/codegen/declarations/object-shape-widening.ts
coercion-sites-allow:
  - src/codegen/builtin-value-read.ts
files:
  - examples/v8x-js2wasm-spike/README.md
  - examples/v8x-js2wasm-spike/compile-graph.ts
  - examples/v8x-js2wasm-spike/deno.ts
  - examples/v8x-js2wasm-spike/v8x-js2wasm.patch
  - tests/v8x-js2wasm-spike.test.ts
  - tests/fixtures/deno-core-0.407.0/00_primordials.js
  - tests/fixtures/deno-core-0.407.0/00_infra.js
  - tests/fixtures/deno-core-0.407.0/01_core.js
  - tests/helpers/deno-core-bootstrap-probe.ts
  - tests/issue-4376-deno-core-bootstrap.test.ts
  - tests/issue-4376-deno-primordials-runtime.test.ts
  - plan/agent-context/v8x-js2wasm-deno-handover-2026-08-12.md
---
# #4376 — v8x + js2wasm as an engine-free Deno substrate

## Objective

Determine whether js2wasm can sit behind v8x's `rusty_v8`-compatible Rust API
so that:

1. Deno-facing code continues to call the API it already knows;
2. raw TypeScript module graphs retain their type information and compile
   directly to WasmGC rather than being transpiled to JavaScript;
3. Wasmtime executes the result without V8, JavaScriptCore, or QuickJS; and
4. a deployed artifact can run without shipping the js2wasm compiler.

The spike deliberately asks the compatibility question before trying to expose
Deno APIs as a new WASI world. Deno's Rust/JavaScript boundary is an object,
module, promise, and callback protocol, not a filesystem-style syscall API.

## Architecture verdict

The approach is viable as a staged architecture, but the spike is not yet a
portable Deno runtime.

```text
build time
  application .ts + Deno wrappers + op manifest
                   |
                   v
          js2wasm --platform deno
                   |
                   v
             linked WasmGC

run time
  deno_core / Rust host calls rusty_v8 API
                   |
                   v
          v8x compatibility layer
                   |
                   v
 shared Engine + Module + Linker + InstancePre
                   |
                   v
       private store + instance per module
                   |
                   v
       compiled wrappers call typed host ops
```

The first internal ABI should use ordinary typed Wasm imports. WIT/component
interfaces can describe the stable outer runtime boundary later, and WASI can
provide standard capabilities such as files, clocks, and sockets. Neither
WASI nor the Component Model replaces the JavaScript object graph that
`deno_core` and its wrappers share.

## What the spike implements

The patch in `examples/v8x-js2wasm-spike/v8x-js2wasm.patch` targets v8x
`v149.4.0-rc.4` at commit
`22cf7342405794d6e1cd851aa43a9b3447654742` and adds an opt-in
`engine_js2wasm` backend.

The implemented vertical slice provides Rust-owned:

- platform and isolate startup;
- contexts, Unicode strings, handles, and persistent handles;
- function/object templates and basic object/property storage;
- module compilation, resolver callbacks, graph instantiation, and evaluation
  promises; and
- exception values plus the complete simdutf compatibility surface.

The module path gathers untouched `.ts` sources through v8x's existing module
resolver, passes the linked graph to js2wasm with `platform: "deno"`, and
precompiles the WasmGC result for embedded Wasmtime 47.0.3. Production v8x
shares one compiler-free Engine and direct-Rust host Linker, caches one
Module/InstancePre per trusted artifact, and gives every evaluated module a
private store/instance that remains alive with its v8x module handle.

The integration fixture enters through the public `rusty_v8` API, evaluates a
typed three-module graph, and calls a Rust-owned `Deno.cwd()` implementation
through two primitive `v8x:deno` imports. It verifies the returned UTF-16
length and checksum against the host working directory and rejects a vacuous
result if no host op was called.

The test binary links neither JSC nor QuickJS. On macOS, `otool -L` reports
only `/usr/lib/libSystem.B.dylib`.

## Unchanged `deno_core` probe

The consumer probe uses Deno commit
`1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44` (Deno 2.9.2,
`deno_core` 0.407.0) and replaces only its workspace `v8` dependency:

```toml
v8 = { package = "v8x", path = "/path/to/v8x", default-features = false, features = ["simdutf", "engine_js2wasm"] }
```

No `deno_core`, `serde_v8`, or Deno JavaScript/TypeScript wrapper source is
patched. All Rust source compiles successfully against the new backend with
the Wasmtime dependency graph resolved in the probe lockfile.

A strict normal link still rejects the incomplete ABI. A diagnostic-only
macOS link with `-undefined dynamic_lookup` was used to discover the first
actually executed missing behavior. It is an instrument, not a supported
deployment configuration.

The diagnostic run initializes the platform and isolate, installs Deno's
callbacks, creates templates and persistent handles, constructs the context,
installs the initial `Deno.core` object graph, and reaches execution of
`ext:core/00_primordials.js`.

The latest diagnostic-only executable was linked with dynamic lookup and run
against the exact raw wrapper artifact. It eventually terminated with exit 139
without producing output, so it does not establish a completed unchanged-Deno
bootstrap or a new semantic checkpoint. The separately controlled public
`Script::Run` integration test is the positive proof for the pinned source
sequence and narrow `setUpAsyncStub` bridge.

### Primordials boundary

`00_primordials.js` captures trusted copies of JavaScript built-ins such as
`Object`, `Array`, `Promise`, and `Reflect` before application code can
monkey-patch them. Deno's later wrappers use those private copies for stable
internal behavior. Primordials are therefore JavaScript object identities and
functions, not Rust ops and not WASI calls.

The compiler adapter had previously
omitted side-effect JavaScript imports because it did not set `allowJs`; fixing
that exposed and then fixed two honest compiler boundaries:

1. #4378 lowers the exact pristine
   `Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]())` capture through
   the native empty-array iterator and returns the genuine shared iterator
   prototype.
2. #4380 makes empty-object widening inspect arrow/function-expression IIFE
   bodies, preventing `primordials` from becoming a null carrier during the
   first property write.

The exact pinned `00_primordials.js`, `00_infra.js`, and `01_core.js` now
compile unchanged as one 2,946,532-byte state-sharing standalone/`deno`
program. Target-gated standardized `try_table` lowering lets Wasmtime 47.0.3
precompile that raw artifact and boot it in two isolated stores. Both stores
return probe value `42`; the captured bootstrap object, `Deno.core`, internals
object, microtask surface, and representative core functions have the expected
stable identities. Seven deferred imports remain, but strict throwing stubs
prove that none is called during bootstrap.

The v8x follow-up also recognizes the exact three pinned source hashes and
their order through the public `rusty_v8` `Script::Run` API, retains one
Wasmtime runtime per context, and exposes the first Rust-visible
`Deno.core.setUpAsyncStub` effect. This is still a prelinked three-script
transaction with a narrow explicit bridge; it does not yet provide general
Rust/Wasm object identity or prove an unchanged `deno_core` process completing
bootstrap.

## What “306 ABI symbols” meant

The initial unchanged-`deno_core` link reported 306 distinct unresolved
symbols in the v8/inspector/shared-handle ABI. This number was a linker
inventory, not 306 missing Deno APIs and not 306 equally important runtime
features. It included:

- symbols needed immediately during startup;
- symbols referenced by compiled Rust code but not executed by this probe;
- overloads and lifecycle helpers representing one semantic operation; and
- inspector/debugger paths unrelated to a minimal production runtime.

The spike implements 106 distinct `v8__*` functions, 10 shared-pointer
compatibility functions, and all 43 simdutf functions. The remaining
diagnostic inventory is 276 symbols. The useful progress measure is therefore
the executed startup boundary—now `00_primordials.js`—rather than trying to
drive the unresolved count to zero with empty stubs.

## Compiler-free deployment answer

Yes: after build-time compilation and Wasmtime precompilation, the deployed
runtime needs only the target-specific trusted `.cwasm` artifact, the Rust/v8x
host layer, and compiler-free embedded Wasmtime. It does not need js2wasm,
Node, Cranelift, or a JavaScript engine.

The spike now proves this explicitly: one test saves the linked Wasm artifact,
and a second invocation evaluates it while the configured compiler path is
`/compiler-is-not-installed`. The production `deno` target must still package
the application, real Deno wrappers, and generated op manifest as that one
ahead-of-time linked program.

## Compile-time cost

The compatibility analyses increase the deterministic #3437 harness traversal
count from 111,568 to 131,133 (+17.5%). This exceeds the prior 15% ceiling, so
the dedicated harness budget is intentionally rebanked with the repository's
provided update command. A follow-up should consolidate the added per-file
scans; this PR accepts the measured compile-time cost for the prototype rather
than hiding it behind a looser percentage margin.

## Spike acceptance

- [x] Preserve raw TypeScript source and use its types during js2wasm
      compilation; do not transpile it to JavaScript first.
- [x] Enter through v8x's public `rusty_v8` module lifecycle.
- [x] Compile and evaluate a linked multi-file graph in Wasmtime without JSC
      or QuickJS.
- [x] Resolve canonical `file:` imports to compileMulti's virtual filesystem
      identity, including incremental compilation (#4377).
- [x] Compile unchanged `deno_core` Rust source against `engine_js2wasm`.
- [x] Advance the diagnostic startup path through `Deno.core` installation to
      `ext:core/00_primordials.js`.
- [x] Fail explicitly at the first state-sharing boundary instead of adding a
      success-shaped no-op ABI stub.
- [x] State the compiler-free deployment shape and the current sidecar
      limitation separately.

## Follow-up acceptance

- [x] Embed Wasmtime, share the Engine/Linker/precompiled Module/InstancePre,
      and keep one isolated store/instance alive per v8x module runtime.
- [x] Compile the exact pinned `00_primordials.js`, `00_infra.js`, and
      `01_core.js` as one state-sharing program and prove value-level bootstrap
      state in two isolated instances.
- [ ] Add extension wrappers and the application to that state-sharing
      program.
- [x] Bind a first Rust op (`Deno.cwd()`) through explicit typed imports.
- [ ] Generate the broader Rust op table imports and preserve exceptions,
      promises, and microtask ordering across the bridge.
- [ ] Return module namespaces and live bindings through the v8x handles.
- [ ] Add dynamic imports, top-level await, synthetic modules, and non-`file:`
      specifier handling as demanded by executed Deno paths.
- [x] Save and run a proof artifact without the compiler sidecar or Node.
- [x] Include JavaScript side-effect modules in the virtual graph and compile
      the pinned unchanged `00_primordials.js` through its first two compiler
      boundaries (#4378, #4380).
- [x] Emit standardized `try_table` EH so the exact wrapper artifact loads in
      v8x's embedded Wasmtime (#2997).
- [x] Route the pinned wrapper source sequence through v8x's public
      `Script::Run` path and observe the first Rust-visible callback effect.
- [ ] Prove the same path from an unchanged Rust `deno_core` executable and
      replace the narrow callback bridge with shared object/function identity.
- [ ] Package the real Deno wrapper/application artifact for distribution.

## Verification

Repository checks:

```sh
pnpm exec vitest run \
  tests/issue-4376-deno-primordials-runtime.test.ts \
  tests/issue-4376-deno-core-bootstrap.test.ts \
  tests/issue-4378-array-prototype-iterator-bootstrap.test.ts \
  tests/issue-4380-empty-object-widening-iife-body.test.ts \
  tests/issue-4377-multifile-exported-object-shorthand-callable.test.ts \
  tests/v8x-js2wasm-spike.test.ts \
  tests/multi-file.test.ts
pnpm run typecheck
pnpm exec prettier --check \
  examples/v8x-js2wasm-spike/compile-graph.ts \
  tests/v8x-js2wasm-spike.test.ts \
  examples/v8x-js2wasm-spike/README.md
```

Patched-v8x checks:

```sh
cargo check --no-default-features --features engine_js2wasm,simdutf --lib
cargo test --no-default-features \
  --features engine_js2wasm,simdutf \
  --test rv8_test_simdutf

V8X_JS2WASM_COMPILER_SCRIPT=/absolute/path/to/compile-graph.ts \
V8X_JS2WASM_WORKDIR=/absolute/path/to/js2wasm \
V8X_JS2WASM_ARTIFACT_OUTPUT=/tmp/deno-app.cwasm \
cargo test --no-default-features \
  --features js2wasm_spike,simdutf \
  --test js2wasm_spike

V8X_JS2WASM_AOT_MODULE=/tmp/deno-app.cwasm \
V8X_JS2WASM_COMPILER=/compiler-is-not-installed \
cargo test --no-default-features \
  --features engine_js2wasm,simdutf \
  --test js2wasm_spike
```

The pinned unchanged-Deno probe also passes
`cargo check -p deno_core --example hello_world` after resolving the Wasmtime
45 dependency graph.

The exact Deno bootstrap and focused primordials regressions pass 16/16. The
unchanged pinned three-file wrapper graph produces a 2,946,121-byte artifact,
boots in two isolated stores, returns probe `42` twice, and calls none of its
seven deferred imports. The broader focused audit passes 109/109 relevant
tests; five failures in `issue-1472.test.ts` reproduce unchanged on pristine
`origin/main`. Prior results remain: simdutf 14/14, v8x source-compile
integration 1/1, compiler-free AOT integration 1/1 with one module load and
two isolated instantiations, and TypeScript project type-checking all pass.
The compiler-free dependency graph contains neither `wasmtime-cranelift` nor
`cranelift-codegen`; on Apple arm64 the stripped test runtime is 1,768,024
bytes and its `.cwasm` fixture is 1,434,192 bytes. The zero-context
patch also reverse-applies cleanly with `git apply --unidiff-zero` to the pinned
dirty v8x probe checkout.

## Handover

The exact pins, stop point, reproduction steps, rejected shortcuts, and safest
next slice are recorded in
[`plan/agent-context/v8x-js2wasm-deno-handover-2026-08-12.md`](../agent-context/v8x-js2wasm-deno-handover-2026-08-12.md).

The initial spike merged in
[#4396](https://github.com/loopdive/js2wasm/pull/4396). The compiler/runtime
follow-ups and primordials bootstrap merged in
[#4404](https://github.com/loopdive/js2wasm/pull/4404). The v8x-side changes
are published as ready
[`loopdive/v8x#1`](https://github.com/loopdive/v8x/pull/1) from
[`codex/js2wasm-module-backend`](https://github.com/loopdive/v8x/tree/codex/js2wasm-module-backend)
at `f37c7d3d1cb9423abdb5399cd1d0b6dd5d7638d2`.
