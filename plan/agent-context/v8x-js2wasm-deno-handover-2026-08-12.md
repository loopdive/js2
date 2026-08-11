# v8x + js2wasm Deno spike handover — 2026-08-12

The spike is published in
[#4396](https://github.com/loopdive/js2wasm/pull/4396). Its authoritative task
record is
[`#4376`](../issues/4376-v8x-js2wasm-deno-core-compatibility-spike.md).

## Exact stop point

- Branch: `codex/v8x-js2wasm-deno-spike`
- Implementation commit: `f26d0bf23a59e89a23979f27ddf744e762a6b61f`
- PR base: `loopdive/js2wasm:main`
- v8x pin: `v149.4.0-rc.4`, commit
  `22cf7342405794d6e1cd851aa43a9b3447654742`
- Deno pin: `1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44`
  (Deno 2.9.2, `deno_core` 0.407.0)
- Strict consumer result: unchanged `deno_core` Rust source compiles; normal
  linking refuses 276 unresolved ABI symbols.
- Diagnostic execution result: startup reaches
  `ext:core/00_primordials.js`, then v8x reports the missing shared-instance
  semantic boundary as an explicit failure.

The local `.tmp` v8x and Deno checkouts were disposable instruments. Do not
depend on them; the checked-in patch, issue, tests, and this handover are the
portable record.

## Shipped artifacts

- `examples/v8x-js2wasm-spike/v8x-js2wasm.patch` — the complete v8x backend
  patch plus its `rusty_v8` integration test.
- `examples/v8x-js2wasm-spike/compile-graph.ts` — a temporary process-side
  compiler adapter that accepts the canonical module manifest and invokes
  `compileMulti()` with `target: "standalone", platform: "deno"`.
- `examples/v8x-js2wasm-spike/README.md` — application and Deno probe results,
  current limits, and reproduction commands.
- `tests/v8x-js2wasm-spike.test.ts` — repository-owned proof that untouched,
  typed, multi-file TypeScript compiles and evaluates under Wasmtime.

## What is proven

1. v8x can provide a third engine backend without enabling its JSC or QuickJS
   implementations.
2. The `rusty_v8` module API can collect raw TypeScript sources and preserve
   normal resolver callbacks while js2wasm performs compilation.
3. Wasmtime can execute the resulting linked WasmGC graph.
4. The relevant isolate, context, handle, string, template, object, property,
   module, and promise state can be Rust-owned.
5. `deno_core` can compile unchanged against the compatibility surface.
6. The intended deployed form can omit the compiler after ahead-of-time
   compilation.

## What is not proven

- A booting `deno_core` or portable Deno runtime.
- Deno ops or Web/Node API providers.
- Module namespace objects or live binding updates returning through
  `rusty_v8`.
- Shared promise and microtask semantics between Rust and compiled wrappers.
- Dynamic imports, top-level await, synthetic modules, or general URL/module
  loading.
- Compiler-free packaging; the current proof still invokes Node/js2wasm at
  module evaluation time.

Do not phrase “unchanged `deno_core` compiles” as “Deno runs.” The strict link
still rejects the incomplete ABI, and the diagnostic link exists only to
identify the next executed boundary.

## Why the bridge stops at `00_primordials.js`

Before the first core wrapper runs, Rust creates and populates the initial
`Deno.core` object graph. `00_primordials.js` reads and mutates that graph.

The module proof currently spawns Wasmtime for a closed source graph. That
process cannot see the Rust-owned object identities, properties, callbacks,
and op registrations. Treating script execution as successful would therefore
discard observable state and create a false boot.

The required next seam is one persistent embedded Wasmtime store/instance with
a typed host bridge. The wrapper code and the Rust host must see the same
logical objects and the same promise/microtask queues.

## Decisions already settled

- **Keep TypeScript.** Do not transpile Deno's `.ts` wrappers to `.js` before
  js2wasm; their types are useful compiler input and disappear at runtime.
- **Do not use WasmGC mode intended for a JavaScript host.** This runtime has no
  JavaScript host. The backend owns its runtime state and Wasmtime hosts it.
- **Do not emulate the whole V8 C++ API.** v8x's Rust ABI boundary is narrower
  and already matches `deno_core`'s dependency. Implement behavior only when
  the executed Deno path demands it.
- **Do not chase the unresolved-symbol count with stubs.** The initial 306 and
  remaining 276 are linker inventories, not feature counts. An explicit
  refusal is better than a success-shaped no-op.
- **Start with plain typed Wasm imports.** They are the smallest internal op
  ABI. Add WIT/component packaging once the bridge semantics stabilize; use
  WASI for standard capabilities, not as a substitute for Deno's JavaScript
  object model.
- **Compile ahead of time for deployment.** The end state ships a linked Wasm
  artifact, v8x's Rust host layer, and Wasmtime—not js2wasm or Node.

## Safest next implementation slice

Build the smallest state-sharing path through the first Deno core wrapper:

1. Embed Wasmtime in the v8x backend and create one store/instance per isolate
   or explicitly documented runtime unit.
2. Replace the process-side evaluation result with an in-process instance
   handle owned alongside the isolate/context state.
3. Compile `00_primordials.js` and the minimum prerequisite wrapper sources
   into the same program as a tiny probe application.
4. Define typed imports for only the Rust ops executed by that program. Keep
   the op manifest explicit and generated from the same source of truth Deno
   uses.
5. Bridge the initial `Deno.core` namespace into the instance with stable
   identity and observable property writes.
6. Prove one value-level effect after wrapper execution, not merely successful
   return—for example, a known primordial captured and read back through the
   same context.
7. Advance to `00_infra.js` and extension wrappers only after that proof. Add
   additional `rusty_v8` ABI functions when an executed call requires them.

Keep the first slice narrow. Module namespace exports, live bindings, dynamic
imports, top-level await, synthetic modules, inspector support, and full Web or
Node APIs are separate layers.

## Reproduction

Apply the patch to the exact v8x pin and initialize its `rusty_v8` submodule.
From that checkout:

```sh
cargo check --no-default-features --features engine_js2wasm,simdutf --lib

cargo test --no-default-features \
  --features engine_js2wasm,simdutf \
  --test rv8_test_simdutf

V8X_JS2WASM_COMPILER_SCRIPT=/absolute/path/to/js2wasm/examples/v8x-js2wasm-spike/compile-graph.ts \
V8X_JS2WASM_WORKDIR=/absolute/path/to/js2wasm \
cargo test --no-default-features \
  --features js2wasm_spike,simdutf \
  --test js2wasm_spike
```

For the unchanged-Deno compile probe, pin the Deno checkout above and replace
its workspace `v8` dependency with:

```toml
v8 = { package = "v8x", path = "/absolute/path/to/v8x", default-features = false, features = ["simdutf", "engine_js2wasm"] }
```

Then run:

```sh
cargo build -p deno_core --example hello_world
```

The expected strict result is successful Rust compilation followed by linker
rejection of the remaining ABI. Do not make the diagnostic
`-undefined dynamic_lookup` option part of a production build.

## Last green validation

- Repository integration: 1/1 passed.
- v8x js2wasm integration: 1/1 passed.
- Vendored simdutf suite: 14/14 passed.
- Repository TypeScript typecheck: passed.
- Focused Prettier check: passed.
- Patch reverse-apply check against the pinned v8x checkout: passed.
- Commit and pre-push repository hooks: passed.

## Resume checklist

1. Read issue #4376 and this handover completely.
2. Verify PR #4396's final state and use its checked-in patch as the source of
   truth.
3. Recreate the exact v8x and Deno pins; do not silently upgrade either while
   attributing ABI movement.
4. Re-run the module integration and strict Deno consumer compile as positive
   controls.
5. Measure progress by the next executed semantic boundary and a value-level
   state effect, not only by a smaller unresolved-symbol inventory.
6. File each newly discovered independent defect as its own `plan/issues`
   markdown record before widening the implementation.
