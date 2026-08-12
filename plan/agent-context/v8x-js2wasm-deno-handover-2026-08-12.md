# v8x + js2wasm Deno spike handover — 2026-08-12

The initial spike merged in
[#4396](https://github.com/loopdive/js2wasm/pull/4396). Its compiler/runtime
follow-ups and primordials bootstrap merged in
[#4404](https://github.com/loopdive/js2wasm/pull/4404). The authoritative task
record is
[`#4376`](../issues/4376-v8x-js2wasm-deno-core-compatibility-spike.md).
The v8x backend itself is published as ready
[`loopdive/v8x#1`](https://github.com/loopdive/v8x/pull/1).

## Exact stop point

- Branch: `codex/v8x-js2wasm-deno-spike`
- Prior spike commit: `f26d0bf23a59e89a23979f27ddf744e762a6b61f`
- Compiler ABI fix: `35423bb9c1d4aa`
- Embedded runtime follow-up: `3917c3caa3a63e`
- Primordials bootstrap: `b0386cbd5e5afd`
- Published v8x branch:
  `loopdive/v8x:codex/js2wasm-module-backend` at
  `f37c7d3d1cb9423abdb5399cd1d0b6dd5d7638d2`
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
- Runtime prototype result: compiler-free Wasmtime 47.0.3 shares one Engine,
  direct-Rust host Linker, and cached Module/InstancePre for the trusted
  `.cwasm` artifact. Two private stores/instances call the typed Rust
  `Deno.cwd()` bridge with exact fresh-instance call counts while the compiler
  path is deliberately absent.
- Compiler bootstrap result: the pinned unchanged `00_primordials.js` now
  compiles in the two-source graph. #4378 fixes its pristine
  `Array.prototype` iterator capture; #4380 fixes the IIFE empty-object carrier
  trap. Instrumented execution reaches the first JSON namespace copy.

The local `.tmp` v8x and Deno checkouts were disposable instruments. Do not
depend on them; the checked-in patch, issue, tests, and this handover are the
portable record.

## Shipped artifacts

- `examples/v8x-js2wasm-spike/v8x-js2wasm.patch` — the complete v8x backend
  patch plus its `rusty_v8` integration test.
- `examples/v8x-js2wasm-spike/compile-graph.ts` — a temporary process-side
  compiler adapter that accepts the canonical module manifest and invokes
  `compileMulti()` with `target: "standalone", platform: "deno"`.
- `examples/v8x-js2wasm-spike/deno.ts` — the first typed Deno API adapter,
  exposing natural `Deno.cwd()` syntax over two primitive host imports.
- `examples/v8x-js2wasm-spike/README.md` — application and Deno probe results,
  current limits, and reproduction commands.
- `tests/v8x-js2wasm-spike.test.ts` — repository-owned proof that untouched,
  typed, multi-file TypeScript compiles and emits the explicit Deno host ABI.
- `plan/issues/4377-multifile-exported-object-shorthand-callable.md` and its
  focused test — diagnosis and regression coverage for canonical `file:` URL
  imports in `compileMulti()`.

## What is proven

1. v8x can provide a third engine backend without enabling its JSC or QuickJS
   implementations.
2. The `rusty_v8` module API can collect raw TypeScript sources and preserve
   normal resolver callbacks while js2wasm performs compilation.
3. Embedded Wasmtime can execute the resulting linked WasmGC graph, share its
   engine/precompiled code/import resolution, and keep a private store/instance
   alive with each v8x module handle.
4. The relevant isolate, context, handle, string, template, object, property,
   module, and promise state can be Rust-owned.
5. `deno_core` can compile unchanged against the compatibility surface.
6. A typed Rust op can implement the natural `Deno.cwd()` wrapper shape.
7. The trusted, target-specific `.cwasm` artifact executes with no compiler or
   Node process available; the runtime dependency graph excludes Cranelift.

## What is not proven

- A booting `deno_core` or portable Deno runtime.
- Deno ops beyond the narrow `cwd` proof, or Web/Node API providers.
- Module namespace objects or live binding updates returning through
  `rusty_v8`.
- Shared promise and microtask semantics between Rust and compiled wrappers.
- Dynamic imports, top-level await, synthetic modules, or general URL/module
  loading.
- Completion of Deno's real `00_primordials.js` bootstrap, compilation of
  `00_infra.js`, extension wrappers, and the generated op manifest into the
  v8x-owned AOT instance. The unchanged first source compiles, but stops during
  builtin namespace reflection.

Do not phrase “unchanged `deno_core` compiles” as “Deno runs.” The strict link
still rejects the incomplete ABI, and the diagnostic link exists only to
identify the next executed boundary.

## Why unchanged Deno still stops at `00_primordials.js`

Before the first core wrapper runs, Rust creates and populates the initial
`Deno.core` object graph. `00_primordials.js` reads and mutates that graph.

Primordials are Deno's private, early-captured copies of JavaScript built-ins
such as `Object`, `Array`, `Promise`, and `Reflect`. Later wrappers rely on
those copies even if application code monkey-patches the globals. They are
JavaScript object identities and functions—not Rust ops or WASI calls.

The module prototype now shares compiler-free Wasmtime runtime/code/import
state while giving every evaluated module a persistent private store/instance,
and proves a typed `Deno.cwd()` host call. On the compiler side, the pinned
unchanged source is now included honestly with `allowJs` and compiles after two
focused fixes (#4378 and #4380). A temporary checkpoint instrument (not part of
the source or commit) proves execution advances through trusted Reflect/
Function helper capture and stops at:

```js
copyPropsRenamed(globalThis["JSON"], primordials, "JSON");
```

That is #3571's corrected boundary: standalone can name some builtin carriers,
but does not yet reify `globalThis` namespace entries such as JSON/Math/Reflect
as objects whose own keys and descriptors Deno can copy. The full compiled
artifact also has `env.Promise_new`, `env.Promise_then2`, and two
`js2wasm:runtime-eval` imports. Wasmtime 45 additionally rejects the emitted
legacy exception encoding (#2997), although Node's Wasm engine can execute the
diagnostic far enough to identify the semantic stop.

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
- **Compile and Wasmtime-precompile ahead of time for deployment.** The end
  state ships a trusted target-specific `.cwasm` artifact, v8x's Rust host
  layer, and compiler-free Wasmtime—not js2wasm, Node, or Cranelift.

## Safest next implementation slice

Build the smallest path from the proven `Deno.cwd()` adapter into the first
real Deno core wrapper:

1. Implement #3571's bounded builtin-object value surface needed by the
   namespace and intrinsic copy loops, starting with JSON/Math/Reflect and
   proving real own-key/descriptor results rather than empty carriers.
2. Remove or replace the Promise and runtime-eval host imports retained by the
   full primordials graph, and migrate standalone exception output to
   standardized `try_table` through #2997 so embedded Wasmtime can load it.
3. Route `00_primordials.js` and the minimum prerequisite wrapper sources into
   v8x's persistent instance as the same program as a tiny probe application.
4. Generate typed imports for only the Rust ops executed by that program. Keep
   the op manifest explicit and generated from the same source of truth Deno
   uses.
5. Bridge the initial `Deno.core` namespace into the instance with stable
   identity and observable property writes.
6. Prove one value-level effect after wrapper execution, not merely successful
   return—for example, a known primordial captured and read back through the
   same context.
7. Add the promise/microtask behavior exercised by this graph within the same
   persistent store.
8. Advance to `00_infra.js` and extension wrappers only after that proof. Add
   additional `rusty_v8` ABI functions when an executed call requires them.

Keep the first slice narrow. Module namespace exports, live bindings, dynamic
imports, top-level await, synthetic modules, inspector support, and full Web or
Node APIs are separate layers.

## Reproduction

Apply the patch to the exact v8x pin with
`git apply --unidiff-zero /path/to/v8x-js2wasm.patch`, initialize its
`rusty_v8` submodule, and from that checkout run:

```sh
cargo check --no-default-features --features engine_js2wasm,simdutf --lib

cargo test --no-default-features \
  --features engine_js2wasm,simdutf \
  --test rv8_test_simdutf

V8X_JS2WASM_COMPILER_SCRIPT=/absolute/path/to/js2wasm/examples/v8x-js2wasm-spike/compile-graph.ts \
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

For the unchanged-Deno compile probe, pin the Deno checkout above and replace
its workspace `v8` dependency with:

```toml
v8 = { package = "v8x", path = "/absolute/path/to/v8x", default-features = false, features = ["simdutf", "engine_js2wasm"] }
```

Then run:

```sh
cargo check -p deno_core --example hello_world
```

This verifies unchanged Deno Rust source against the v8x API. A separate
strict `cargo build` is expected to reach the normal linker and reject the
remaining ABI. Do not make the diagnostic `-undefined dynamic_lookup` option
part of a production build.

## Last validation

- Focused compiler/v8x plus existing multi-file regression tests: 20/20
  passed.
- Bootstrap regressions #4378/#4380: 5/5 passed; each artifact has zero host
  imports.
- Pinned unchanged `00_primordials.js`: compiles as a two-module graph;
  checkpointed diagnostic reaches the first JSON namespace copy.
- v8x source-compile js2wasm integration: 1/1 passed.
- v8x compiler-free AOT integration with an invalid compiler path: 1/1
  passed; the test observes one module load, one cached module, two isolated
  instantiations, and exact value-level `Deno.cwd()` host-call counts.
- Compiler-free dependency audit: no `wasmtime-cranelift` or
  `cranelift-codegen`. Apple-arm64 stripped test runtime: 1,768,024 bytes;
  precompiled fixture: 1,434,192 bytes.
- Vendored simdutf suite: 14/14 passed.
- Unchanged `deno_core` Rust consumer check: passed with Wasmtime 45.
- Repository TypeScript typecheck: passed.
- Focused Prettier check: passed.
- Patch reverse-apply check against the pinned v8x checkout with
  `git apply --unidiff-zero`: passed.

The unrelated `tests/issue-700-test262-language-service.test.ts` suite still
has three pre-existing harness failures (`sameValue is not a function` twice
and one stale exact-source assertion). This follow-up changes neither the
worker nor its original-harness fixtures; the new incremental file-URL
regression itself passes.

## Resume checklist

1. Read issue #4376 and this handover completely.
2. Treat merged PR #4396 as the initial spike and verify follow-up PR #4404's
   final state; use their checked-in patch and tests as the source of truth.
3. Recreate the exact v8x and Deno pins; do not silently upgrade either while
   attributing ABI movement.
4. Re-run the module integration and strict Deno consumer compile as positive
   controls.
5. Measure progress by the next executed semantic boundary and a value-level
   state effect, not only by a smaller unresolved-symbol inventory.
6. File each newly discovered independent defect as its own `plan/issues`
   markdown record before widening the implementation.
