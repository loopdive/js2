# v8x + js2wasm spike

This spike adds an experimental, engine-free v8x backend while preserving the
public `rusty_v8` module lifecycle:

```text
raw .ts source
      │
      ▼
v8x CompileModule ── stores source in a Rust-owned handle
      │
      ▼
v8x InstantiateModule ── calls the normal V8 resolver for every import
      │
      ▼
linked TypeScript graph ── js2wasm target=standalone, platform=deno
      │
      ▼
WasmGC module ── Wasmtime evaluates it
```

The integration test uses two `.ts` modules containing real type annotations.
The entry module imports a typed function from the second module and checks its
result at runtime. It enters through the public `rusty_v8` API rather than
calling js2wasm directly.

## Files

- `compile-graph.ts` is the temporary compiler sidecar used by v8x.
- `v8x-js2wasm.patch` adds the opt-in backend and its rusty_v8 integration test
  to v8x `v149.4.0-rc.4` at commit `22cf7342405794d6e1cd851aa43a9b3447654742`.
- `../../tests/v8x-js2wasm-spike.test.ts` tests the sidecar independently.

## Run the v8x proof

Apply `v8x-js2wasm.patch` to a v8x checkout, initialize its `rusty_v8`
submodule, and run:

```sh
V8X_JS2WASM_COMPILER_SCRIPT=/absolute/path/to/js2wasm/examples/v8x-js2wasm-spike/compile-graph.ts \
V8X_JS2WASM_WORKDIR=/absolute/path/to/js2wasm \
cargo test --no-default-features \
  --features js2wasm_spike \
  --test js2wasm_spike
```

The feature is a third backend and does not enable the JSC or QuickJS features.

## What this proves

- TypeScript can remain the module input; there is no TS-to-JS transpilation.
- Isolates, contexts, strings, handles, modules, and evaluation promises in the
  tested path are Rust-owned; JSC and QuickJS are not linked.
- v8x retains V8-compatible module handles and resolver callbacks while
  js2wasm performs compilation and Wasmtime performs execution.
- A linked multi-file graph can be lowered by js2wasm and run by Wasmtime.

On macOS, `otool -L` reports only `/usr/lib/libSystem.B.dylib` for the test
binary. The backend currently implements 106 distinct `v8__*` functions, 10
`std::shared_ptr` compatibility functions, and the 43-function simdutf ABI in
Rust. The vendored simdutf test suite passes all 14 tests.

## `deno_core` compatibility probe (path 1)

The follow-up probe keeps `deno_core` unchanged and substitutes v8x at its
existing `v8` crate boundary. It uses v8x's pinned Deno commit
`1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44` (Deno 2.9.2,
`deno_core` 0.407.0).

The Deno workspace dependency used by the probe is:

```toml
v8 = { package = "v8x", path = "/path/to/v8x", default-features = false, features = ["simdutf", "engine_js2wasm"] }
```

Then `cargo build -p deno_core --example hello_world` is the strict consumer
check. No `deno_core`, `serde_v8`, or Deno JS/TS wrapper source is patched.

That real consumer compiles all Rust code successfully against
`engine_js2wasm`. A normal link deliberately remains strict and rejects the
remaining ABI. The diagnostic binary contains 276 distinct unresolved
V8/inspector/shared-handle symbols. A diagnostic-only macOS link using
`-undefined dynamic_lookup` was used to find the first actually executed
missing call; it is not part of the backend and is not a deployment mode.

With that diagnostic instrument, the unchanged `deno_core` `hello_world`
example now:

1. initializes the custom v8x platform,
2. creates an isolate,
3. installs Deno's microtask, exception, module, and Wasm callbacks, and
4. creates function/object templates and persistent handles,
5. constructs a context and its global/extras objects,
6. installs the initial `Deno.core` namespace using Rust-owned properties, and
7. requests execution of `ext:core/00_primordials.js`.

At that point v8x returns an explicit execution failure instead of pretending
that a detached Wasmtime subprocess succeeded. Deno's wrapper writes must be
visible through the same `Deno.core` object graph that Rust just populated.
That requires a persistent Wasmtime instance plus a typed host bridge, or an
AOT-specific `deno_core` adapter that hands the wrapper sources and op manifest
to js2wasm as one linked program. It cannot be solved correctly by another
empty V8 ABI stub.

## What remains

This is not yet a portable Deno runtime. The implemented ABI functions cover
the module vertical slice, platform/isolate startup, templates, persistent
handles, contexts, Unicode strings, and the basic object/property model. The
compiler sidecar currently runs under Node, and Wasmtime is spawned as a
process; both boundaries must eventually become embedded or self-hosted to
remove that deployment dependency.

The intended deployed shape does not require the compiler: compile and link the
application plus Deno's JS/TS wrappers to a Wasm artifact at build time, then
ship only that artifact, v8x's Rust host layer, and Wasmtime. The current spike
still compiles on module evaluation, so it is a development proof rather than
that packaged layout.

The next useful slice is the shared Deno bridge, not a broad symbol-filling
exercise. It must compile `00_primordials.js`, `00_infra.js`, extension wrappers,
and the application into a state-sharing Wasm program; bind the Rust op table as
typed imports; and keep promises/microtasks in the same instance. Remaining
rusty_v8 functions should then be implemented only when this path actually
executes them.

Not covered by this spike:

- Deno ops or Web/Node API providers
- module namespace exports and live bindings back into rusty_v8
- dynamic imports, top-level await, or synthetic modules
- non-`file:` specifiers
- complex or multiline import syntax in v8x's temporary graph scanner
- a complete rusty_v8 ABI or a booting `deno_core`
