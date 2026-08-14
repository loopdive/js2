# Runtime eval as a Wasm side module (#3630)

This proof of concept adds a third runtime-eval architecture alongside the
native bytecode interpreter and QuickJS: compile the eval source on demand to a
new core-Wasm module, instantiate it through host capabilities, and execute its
export.

The same 295-byte broker module runs under a JavaScript host and a native
Wasmtime embedder. It imports the narrow WebAssembly object operations it needs:

| Import | Core-Wasm signature | JavaScript provider | Wasmtime provider |
| --- | --- | --- | --- |
| `WebAssembly::memory` | `(memory 64)` | `WebAssembly.Memory` | `wasmtime::Memory` |
| `WebAssembly::Module` | `(i32, i32) -> externref` | `new WebAssembly.Module(bytes)` | `wasmtime::Module::new(engine, bytes)` |
| `WebAssembly::Instance` | `(externref) -> externref` | `new WebAssembly.Instance(module, {})` | `wasmtime::Instance::new(store, module, [])` |
| `WebAssembly.Instance::callExportF64` | `(externref, i32, i32) -> f64` | calls `instance.exports[name]()` | resolves and calls the typed native export |
| `js2wasm:compiler::compileEval` | `(i32, i32, i32, i32) -> i32` | calls js2wasm in process | invokes the deterministic compiler helper |

`externref` is important here: it carries the host's real Module and Instance
objects. The ABI does not expose Wasmtime handles or force JavaScript hosts to
maintain an integer object table. The compiled side module is zero-import
standalone Wasm and is compiled in the same Wasmtime engine that instantiates
it, preserving WebAssembly GC type canonicalization.

## Run it

JavaScript host:

```sh
node --import tsx examples/runtime-eval-side-module/js-host.mjs "6 * 7"
```

Wasmtime embedding host (the Rust dependencies are pinned to the repository's
Wasmtime 46 line):

```sh
node examples/runtime-eval-side-module/broker.mjs /tmp/runtime-eval-broker.wasm
cargo run --offline --manifest-path examples/runtime-eval-side-module/wasmtime-host/Cargo.toml -- \
  /tmp/runtime-eval-broker.wasm "$PWD" "6 * 7"
```

Both commands report `result: 42`, one compiler invocation, and the generated
side-module byte length.

## Deliberate POC limits

- The source grammar is one expression and its result is `f64`. This isolates
  the compile/instantiate/call boundary from boxed JS-value and scope ABIs.
- The current compiler capability uses the full js2wasm TypeScript front end.
  It is a replaceable provider, not part of the WebAssembly object ABI. The
  intended production provider is the self-hosted Acorn + all-dynamic IR/codegen
  payload described in #3630.
- Direct eval scope capture, write-back, exception transfer, caching, CSP/policy
  controls, and arbitrary side-module imports remain production work.
- Wasmtime launches the compiler helper at runtime, but it instantiates and
  executes both broker and generated module natively. This proves the portable
  host boundary; it does not claim a self-contained Wasmtime compiler payload.

The native interpreter remains an independent option. This experiment is
additive and does not change the default runtime-eval backend.
