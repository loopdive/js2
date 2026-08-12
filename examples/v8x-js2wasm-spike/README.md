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
WasmGC module ── Wasmtime precompile at build time
      │
      ▼
trusted .cwasm ── shared Engine + Module + Linker + InstancePre
      │
      ├── private Store + Instance A
      └── private Store + Instance B
      │
      ▼
typed v8x:deno imports ── Rust host ops (`Deno.cwd()` in this slice)
```

The integration test uses three `.ts` modules containing real type
annotations. The entry module imports a typed function and a small Deno API
adapter, calls `Deno.cwd()`, and verifies its UTF-16 result against the Rust
process working directory. It enters through the public `rusty_v8` API rather
than calling js2wasm directly.

## Files

- `compile-graph.ts` is the temporary compiler sidecar used by v8x. Its
  optional `--optimize 1|2|3|4` argument runs `wasm-opt` at that level and
  fails rather than silently returning unoptimized output when the optimizer
  is unavailable or rejects the module.
- `deno.ts` is the first typed Deno API adapter. It presents the natural
  `Deno.cwd()` object shape and lowers it to two primitive host imports.
- `v8x-js2wasm.patch` adds the opt-in backend and its rusty_v8 integration test
  to v8x `v149.4.0-rc.4` at commit `22cf7342405794d6e1cd851aa43a9b3447654742`.
- The same patch is published on
  [`loopdive/v8x:codex/js2wasm-module-backend`](https://github.com/loopdive/v8x/tree/codex/js2wasm-module-backend)
  at commit `074091faa356043c1795ebeab159c86bf77ab62f`.
- `../../tests/v8x-js2wasm-spike.test.ts` tests the sidecar independently.

## Run the v8x proof

Apply `v8x-js2wasm.patch` to a v8x checkout with
`git apply --unidiff-zero v8x-js2wasm.patch`, initialize its `rusty_v8`
submodule, and run:

```sh
V8X_JS2WASM_COMPILER_SCRIPT=/absolute/path/to/js2wasm/examples/v8x-js2wasm-spike/compile-graph.ts \
V8X_JS2WASM_WORKDIR=/absolute/path/to/js2wasm \
V8X_JS2WASM_ARTIFACT_OUTPUT=/tmp/deno-app.cwasm \
cargo test --no-default-features \
  --features js2wasm_spike \
  --test js2wasm_spike
```

This compiles once and saves the linked artifact. The same test then runs
without Node or js2wasm when given only that artifact:

```sh
V8X_JS2WASM_AOT_MODULE=/tmp/deno-app.cwasm \
V8X_JS2WASM_COMPILER=/compiler-is-not-installed \
cargo test --no-default-features \
  --features engine_js2wasm \
  --test js2wasm_spike
```

The production feature is a third backend, embeds Wasmtime 47.0.3, and enables
neither JSC, QuickJS, nor Wasmtime's Cranelift compiler. The `.cwasm` file is
target-specific executable code and must be produced by a trusted build using
the same Wasmtime version and configuration; it must remain immutable while
the runtime maps it.

## What this proves

- TypeScript can remain the module input; there is no TS-to-JS transpilation.
- Isolates, contexts, strings, handles, modules, and evaluation promises in the
  tested path are Rust-owned; JSC and QuickJS are not linked.
- v8x retains V8-compatible module handles and resolver callbacks while
  js2wasm performs build-time compilation and embedded Wasmtime performs
  execution.
- A linked multi-file graph can be lowered by js2wasm and run by Wasmtime.
- One shared Wasmtime Engine, host Linker, and cached precompiled module can
  create multiple isolated stores/instances. The integration test observes one
  module load and two independent instantiations, and each fresh store must
  make the exact expected number of typed `Deno.cwd()` host calls.
- The resulting artifact runs when the compiler executable is absent.

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

Then `cargo check -p deno_core --example hello_world` is the Rust consumer
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

That diagnostic still stops before the real wrapper can execute through v8x.
The compiler side of the next slice now includes JavaScript graph sources
honestly (`allowJs: true`) and compiles Deno's pinned, unchanged
`00_primordials.js`. Two bootstrap blockers were fixed: capturing
`%ArrayIteratorPrototype%` from the pristine `Array.prototype`, and running the
empty-object shape prepass inside arrow/function-expression IIFEs.

An instrumented diagnostic run advances through Deno's initial trusted helper
capture and reaches `copyPropsRenamed(globalThis["JSON"], ...)`. The next
boundary is reifying builtin namespace objects as inspectable standalone
values (#3571). The compiled full file also retains Promise host imports and
runtime-eval imports, so this is not yet a host-free completed bootstrap.

### What primordials are

`ext:core/00_primordials.js` captures trusted copies of JavaScript built-ins
such as `Object`, `Array`, `Promise`, and `Reflect` before application code can
replace or monkey-patch them. Later Deno wrappers use those private copies so
their internal behavior remains dependable. They are ordinary bootstrap
JavaScript values and functions—not Rust ops or a WASI interface—which is why
compiling the real primordials wrapper is the next important object-identity
test.

## What remains

This is not yet a portable Deno runtime. The implemented ABI functions cover
the module vertical slice, platform/isolate startup, templates, persistent
handles, contexts, Unicode strings, and the basic object/property model. The
compiler sidecar currently runs under Node at build time. Wasmtime is embedded;
runtime execution no longer crosses a process boundary.

The deployed shape does not require the compiler: compile and link the
application plus Deno's JS/TS wrappers to raw WasmGC, precompile that output to
a target-specific `.cwasm` file, then ship only that trusted artifact, v8x's
Rust host layer, and compiler-free Wasmtime. The AOT test proves that path and
the runtime dependency graph contains no `wasmtime-cranelift` or
`cranelift-codegen`, although packaging and the real Deno wrapper graph remain
future work.

The next useful slice remains the real Deno bootstrap graph, not a broad
symbol-filling exercise. The first source now compiles, but v8x must route it
into the existing state-sharing Wasm program; builtin namespace/prototype
objects must be inspectable; Promise/microtask and indirect-eval imports must
be made host-free or eliminated; and Wasmtime needs standardized `try_table`
exception encoding (#2997). Only then should the graph advance to
`00_infra.js`, generated typed op imports, extension wrappers, and the
application. Remaining rusty_v8 functions should still be implemented only
when this path actually executes them.

Not covered by this spike:

- Deno ops beyond the typed `cwd` proof, or Web/Node API providers
- module namespace exports and live bindings back into rusty_v8
- dynamic imports, top-level await, or synthetic modules
- non-`file:` specifiers
- complex or multiline import syntax in v8x's temporary graph scanner
- a complete rusty_v8 ABI or a booting `deno_core`
