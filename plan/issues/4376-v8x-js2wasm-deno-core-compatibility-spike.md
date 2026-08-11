---
id: 4376
title: "Spike v8x as a rusty_v8-compatible js2wasm backend for a compiler-free Deno runtime"
status: in-review
created: 2026-08-12
updated: 2026-08-12
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
related: [1584, 1662, 1772, 2525, 2658, 2928]
origin: "Project-lead request to determine whether js2wasm can run behind v8x and preserve Deno APIs without V8, JSC, or QuickJS"
files:
  - examples/v8x-js2wasm-spike/README.md
  - examples/v8x-js2wasm-spike/compile-graph.ts
  - examples/v8x-js2wasm-spike/v8x-js2wasm.patch
  - tests/v8x-js2wasm-spike.test.ts
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
    one persistent Wasmtime store + instance
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
resolver, passes the linked graph to js2wasm with `platform: "deno"`, and runs
the WasmGC result with Wasmtime. The integration fixture enters through the
public `rusty_v8` API and proves a typed two-module graph evaluates correctly.

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
patched. All Rust source compiles successfully against the new backend.

A strict normal link still rejects the incomplete ABI. A diagnostic-only
macOS link with `-undefined dynamic_lookup` was used to discover the first
actually executed missing behavior. It is an instrument, not a supported
deployment configuration.

The diagnostic run initializes the platform and isolate, installs Deno's
callbacks, creates templates and persistent handles, constructs the context,
installs the initial `Deno.core` object graph, and reaches execution of
`ext:core/00_primordials.js`.

`Script::Run` then refuses explicitly. Launching a detached Wasmtime process
would lose the Rust-owned `Deno.core` properties that the wrapper reads and
mutates. Correct execution requires those writes, op calls, promises, and
microtasks to share one Wasmtime instance and store.

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

Yes: after build-time compilation, the intended deployed runtime needs only
the linked Wasm artifact, the Rust/v8x host layer, and Wasmtime. It does not
need js2wasm, Node, or a JavaScript engine.

The current spike is not packaged that way yet. Its compiler sidecar runs
under Node and compilation happens when the module is evaluated. That is a
development proof of the boundary. The production `deno` target must move
application code, Deno wrappers, and the op manifest into one ahead-of-time
linked program.

## Spike acceptance

- [x] Preserve raw TypeScript source and use its types during js2wasm
      compilation; do not transpile it to JavaScript first.
- [x] Enter through v8x's public `rusty_v8` module lifecycle.
- [x] Compile and evaluate a linked multi-file graph in Wasmtime without JSC
      or QuickJS.
- [x] Compile unchanged `deno_core` Rust source against `engine_js2wasm`.
- [x] Advance the diagnostic startup path through `Deno.core` installation to
      `ext:core/00_primordials.js`.
- [x] Fail explicitly at the first state-sharing boundary instead of adding a
      success-shaped no-op ABI stub.
- [x] State the compiler-free deployment shape and the current sidecar
      limitation separately.

## Follow-up acceptance — not completed by this spike

- [ ] Embed Wasmtime and keep one store/instance alive for the runtime.
- [ ] Compile `00_primordials.js`, `00_infra.js`, extension wrappers, and the
      application as one state-sharing program.
- [ ] Bind the Rust op table through typed imports and preserve exceptions,
      promises, and microtask ordering across the bridge.
- [ ] Return module namespaces and live bindings through the v8x handles.
- [ ] Add dynamic imports, top-level await, synthetic modules, and non-`file:`
      specifier handling as demanded by executed Deno paths.
- [ ] Package and run an artifact without the compiler sidecar or Node.

## Verification

Repository checks:

```sh
pnpm exec vitest run tests/v8x-js2wasm-spike.test.ts
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
cargo test --no-default-features \
  --features js2wasm_spike,simdutf \
  --test js2wasm_spike
```

Results: repository integration 1/1, simdutf 14/14, v8x module integration
1/1, and TypeScript project type-checking all pass. The patch also
reverse-applies cleanly to the pinned dirty v8x probe checkout.

## Handover

The exact pins, stop point, reproduction steps, rejected shortcuts, and safest
next slice are recorded in
[`plan/agent-context/v8x-js2wasm-deno-handover-2026-08-12.md`](../agent-context/v8x-js2wasm-deno-handover-2026-08-12.md).

Implementation is published in ready PR
[#4396](https://github.com/loopdive/js2wasm/pull/4396).
