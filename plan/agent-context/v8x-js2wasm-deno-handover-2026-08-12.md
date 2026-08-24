# v8x + js2wasm Deno spike handover — 2026-08-12

Updated 2026-08-22 with the exact six-source Wasmtime artifact, the real Rust
scalar-op bridge, and a successful unchanged-`deno_core` `hello_world` run.

The initial spike merged in
[#4396](https://github.com/loopdive/js2wasm/pull/4396). Its compiler/runtime
follow-ups and primordials bootstrap merged in
[#4404](https://github.com/loopdive/js2wasm/pull/4404). The authoritative task
record is
[`#4376`](../issues/4376-v8x-js2wasm-deno-core-compatibility-spike.md).
The baseline v8x backend is published in
[`loopdive/v8x#1`](https://github.com/loopdive/v8x/pull/1); the strict-boot
follow-up is committed on that PR branch at the exact head recorded below.

## Exact stop point

- Compiler branch: `codex/4376-deno-core-boot-vertical-slice`, with the #4376
  implementation at `89ea611b4556a8f3b469d27213da12f6d6eadb10` and current
  `origin/main` merged before publication.
- Historical merged commits: initial spike
  `f26d0bf23a59e89a23979f27ddf744e762a6b61f`, compiler ABI fix
  `35423bb9c1d4aa`, embedded runtime follow-up `3917c3caa3a63e`, and
  primordials bootstrap `b0386cbd5e5afd`.
- v8x branch: `loopdive/v8x:codex/js2wasm-module-backend`, head
  `3095ded9b69055ecc936109cf71d270d4acf6c79`.
- PR base: `loopdive/js2wasm:main`
- v8x pin: `v149.4.0-rc.4`, commit
  `22cf7342405794d6e1cd851aa43a9b3447654742`
- Deno pin: `1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44`
  (Deno 2.9.2, `deno_core` 0.407.0)
- Strict consumer result: `cargo run -p deno_core --example hello_world` exits
  0 against the precompiled artifact at the unchanged pinned Deno commit.
- Exact raw artifact: `/private/tmp/deno-core-host-ops.wasm`; the six pinned
  `00_primordials.js`, `00_infra.js`,
  `02_timers.js`, `01_core.js`, `mod.js`, and `hello_world_usage.js` sources
  compile on the measured Darwin arm64 producer to 3,975,227 bytes with SHA-256
  `452d485bd70d7cb8d5d7958e0aebfddf71463a8cb9710de56dffc9ff23f50e85`.
  Linux x64 CI produces the same size and behavior with SHA-256
  `0738f4ca2b8852ee7262bd306efb70754dc4c7d5532288af2b16f46caca0eeda`;
  raw layout is not cross-platform canonical.
- Precompiled artifact: `/private/tmp/deno-core-452d485b.cwasm`, 62,035,464
  bytes with SHA-256
  `05b75d7f1e46f92565c42e5a8a3e336983e7e2b0eecfe4889dadab9075988a5a`.
  The exact precompile/bootstrap test passes 1/1 in 500.49 seconds.
- Import trace: exactly nine `v8x:deno` scalar imports plus seven deferred
  Promise/eval imports. The deferred imports are prelinked but not executed.
- Compiler-side value proof: two isolated Node-hosted stores each advance
  through `42`/`43`/`44`, commit two sums and six UTF-16 prints, and reproduce
  the exact serde `TypeError` and output.
- Runtime prototype result: compiler-free Wasmtime 47.0.3 shares one Engine,
  direct-Rust host Linker, and cached Module/InstancePre for the trusted
  `.cwasm` artifact. Two private stores/instances call the typed Rust
  `Deno.cwd()` bridge with exact fresh-instance call counts while the compiler
  path is deliberately absent.
- Public-API result: v8x validates the exact pinned source hashes/order through
  the public `rusty_v8` lifecycle, keeps the prelinked transaction in one
  persistent context runtime, binds the nine scalar imports to Rust, and
  completes unchanged `deno_core`. This remains a narrow bridge, not general
  Rust/Wasm object identity or a complete Deno API implementation.

The strict stdout is exactly:

```text
The sum of
1,2,3
is
6
Exception:
TypeError: serde_v8 error: invalid type; expected: array, got: Number
```

The local `.tmp` v8x and Deno checkouts were disposable instruments. Do not
depend on them; the checked-in patch, issue, tests, and this handover are the
portable record.

## Shipped artifacts

- `examples/v8x-js2wasm-spike/v8x-js2wasm.patch` — the baseline v8x backend
  patch plus its `rusty_v8` integration test. The current standardized-EH
  public-script follow-up is maintained in `loopdive/v8x#1`.
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
- `tests/fixtures/deno-core-0.407.0/` — the six hash-pinned upstream
  wrapper/module/application sources used by both the compiler and v8x proofs.
- `tests/helpers/deno-core-bootstrap-probe.ts` and
  `tests/issue-4376-deno-core-bootstrap.test.ts` — the exact graph compiler,
  nine-import Node emulator, two-store value proof, and artifact identity gate.
- `src/codegen/analysis/realm-global-structural-carrier.ts` and
  `tests/issue-4376-realm-structural-carrier.test.ts` — the declaration-keyed
  carrier proof needed by the captured Deno wrapper calls.

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
5. Pinned `deno_core` can compile and run unchanged against the compatibility
   surface for the exact `hello_world` program.
6. Typed Rust ops can implement the natural `Deno.cwd()`, `op_sum`, and
   `op_print` wrapper shapes, including the serde `TypeError` and UTF-16 output.
7. The trusted, target-specific `.cwasm` artifact executes with no compiler or
   Node process available; the runtime dependency graph excludes Cranelift.
8. The exact six-source wrapper/module/application graph reaches
   `42`/`43`/`44` in two isolated Wasm stores, with two sums and six prints per
   store and no deferred Promise/eval import calls.
9. Wasmtime 47.0.3 can precompile and execute that graph, and v8x's public
   `rusty_v8` lifecycle completes the unchanged Rust example with exact output.

## What is not proven

- General shared object/function identity between Rust-owned v8 handles and
  the Wasm wrapper heap; the exact path uses narrow explicit bridges.
- Deno ops beyond the `cwd`/`op_sum`/`op_print` proofs, or Web/Node API
  providers.
- Module namespace objects or live binding updates returning through
  `rusty_v8`.
- General shared promise and microtask semantics between Rust and compiled
  wrappers beyond the exact boot path.
- Dynamic imports, top-level await, general synthetic-module behavior, or
  general URL/module loading.
- A generated broad op manifest and a distributable full Deno wrapper/API
  package.

Do not phrase the exact `hello_world` boot as “all of Deno runs.” The diagnostic
layer still contains 237 fail-loud weak definitions for unexecuted paths, and
the successful scalar bridge does not establish general async, namespace, or
Web/Node API semantics.

## Exact wrapper bootstrap versus Rust `deno_core` boot

Before the first core wrapper runs, Rust creates and populates the initial
`Deno.core` object graph. `00_primordials.js` reads and mutates that graph.

Primordials are Deno's private, early-captured copies of JavaScript built-ins
such as `Object`, `Array`, `Promise`, and `Reflect`. Later wrappers rely on
those copies even if application code monkey-patches the globals. They are
JavaScript object identities and functions—not Rust ops or WASI calls.

The compiler side includes all six exact pinned sources honestly with `allowJs`;
no source checkpoint or source transformation is used. A small seed provides
the bootstrap prerequisites and marshals two scalar ops through nine declared
`v8x:deno` imports. Seven Promise/eval imports remain strict deferred imports.
The two-store Node proof calls the Deno bridge exactly two sums and six prints
per store while calling none of those seven deferred imports.

Target-gated standardized `try_table` lowering retires the Wasmtime loader
boundary. The 3,975,227-byte raw artifact precompiles under Wasmtime 47.0.3 to a
separate 62,035,464-byte target artifact. v8x validates the exact sources,
loads that artifact, binds its nine scalar imports to Rust, and the pinned
unchanged `deno_core` process completes with exact output. The remaining
integration boundaries are general shared object/function identity, module
live bindings, broader ops, and async semantics.

## Decisions already settled

- **Keep TypeScript.** Do not transpile Deno's `.ts` wrappers to `.js` before
  js2wasm; their types are useful compiler input and disappear at runtime.
- **Do not use WasmGC mode intended for a JavaScript host.** This runtime has no
  JavaScript host. The backend owns its runtime state and Wasmtime hosts it.
- **Do not emulate the whole V8 C++ API.** v8x's Rust ABI boundary is narrower
  and already matches `deno_core`'s dependency. Implement behavior only when
  the executed Deno path demands it.
- **Do not chase the unresolved-symbol count with stubs.** The initial 306 and
  current 237-symbol diagnostic inventories are not feature counts. The exact
  successful path executes none of the weak fail-loud definitions; an explicit
  refusal remains better than a success-shaped no-op.
- **Start with plain typed Wasm imports.** They are the smallest internal op
  ABI. Add WIT/component packaging once the bridge semantics stabilize; use
  WASI for standard capabilities, not as a substitute for Deno's JavaScript
  object model.
- **Compile and Wasmtime-precompile ahead of time for deployment.** The end
  state ships a trusted target-specific `.cwasm` artifact, v8x's Rust host
  layer, and compiler-free Wasmtime—not js2wasm, Node, or Cranelift.

## Safest next implementation slice

Advance from the exact synchronous `hello_world` vertical slice:

1. Generate typed imports for the next Rust ops demanded by a chosen Deno API;
   keep the op manifest explicit and derived from Deno's source of truth.
2. Replace narrow exact-source namespace handling with general module namespace
   objects and live bindings returned through v8x handles.
3. Add the promise, microtask, and asynchronous-op behavior exercised by the
   next program in the same persistent store.
4. Generalize shared object/function identity only where an executed path
   requires it; retain fail-loud diagnostic definitions elsewhere.
5. Package the trusted wrapper/application `.cwasm`, v8x host layer, and
   reproducible artifact manifest without the compiler or Cranelift.
6. Measure another unchanged-Deno value-level workload, including startup,
   steady-state behavior, import calls, and per-instance memory.

Keep each next slice narrow. Dynamic imports, top-level await, general synthetic
modules, inspector support, and full Web or Node APIs remain separate layers.

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

V8X_JS2WASM_DENO_CORE_WASM=/private/tmp/deno-core-host-ops.wasm \
V8X_JS2WASM_DENO_CORE_AOT_OUTPUT=/private/tmp/deno-core-452d485b.cwasm \
cargo test --no-default-features \
  --features engine_js2wasm,simdutf,js2wasm_runtime_compile \
  --test js2wasm_spike \
  boots_exact_deno_core_artifact_in_two_wasmtime_stores -- --ignored --exact
```

For the unchanged-Deno runtime proof, pin the Deno checkout above and replace
its workspace `v8` dependency with:

```toml
v8 = { package = "v8x", path = "/absolute/path/to/v8x", default-features = false, features = ["simdutf", "engine_js2wasm", "js2wasm_runtime_compile", "js2wasm_diagnostic_abi"] }
```

Then run:

```sh
cargo check -p deno_core --example hello_world
V8X_JS2WASM_DENO_CORE_AOT_MODULE=/private/tmp/deno-core-452d485b.cwasm \
cargo run -p deno_core --example hello_world
```

The check verifies the unchanged source against v8x; the run is the strict
value-level proof and must exit 0 with the six recorded lines. The diagnostic
ABI is an execution instrument for unimplemented paths, not a production
feature, and the successful exact run must not invoke any of its weak symbols.

Generate and verify the exact compiler-side artifact from the js2wasm checkout:

```sh
DENO_CORE_BOOTSTRAP_WASM_OUTPUT=/private/tmp/deno-core-host-ops.wasm \
node --max-old-space-size=2048 --experimental-wasm-exnref --import tsx \
  tests/helpers/deno-core-bootstrap-probe.ts

pnpm exec vitest run \
  tests/issue-4376-deno-primordials-runtime.test.ts \
  tests/issue-4376-deno-core-bootstrap.test.ts \
  tests/issue-4376-realm-structural-carrier.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

## Last validation

- Exact six-source compiler artifact on Darwin arm64: 3,975,227 raw bytes, SHA-256
  `452d485bd70d7cb8d5d7958e0aebfddf71463a8cb9710de56dffc9ff23f50e85`.
  Linux x64 CI reports the same size and semantics with SHA-256
  `0738f4ca2b8852ee7262bd306efb70754dc4c7d5532288af2b16f46caca0eeda`.
  Two stores reach `42`/`43`/`44`, commit two sums and six prints each, reproduce
  the exact `TypeError`/output, and call none of seven deferred imports.
- Focused exact-bootstrap test: 1/1 passed. Focused realm-carrier regressions:
  6/6 passed.
- v8x raw-module precompile/bootstrap test: 1/1 passed in 500.49 seconds. The
  62,035,464-byte `.cwasm` has SHA-256
  `05b75d7f1e46f92565c42e5a8a3e336983e7e2b0eecfe4889dadab9075988a5a`.
- Import trace: exactly nine `v8x:deno` imports plus seven prelinked deferred
  Promise/eval imports; none of the deferred imports executes.
- Unchanged pinned `deno_core` at `1d4e6c1`: `cargo run` exits 0 and prints the
  exact six recorded lines through real Rust ops.
- Broader focused compiler/v8x/multi-file audit: 109/109 relevant tests passed.
  The five `issue-1472.test.ts` failures reproduce identically on pristine
  `origin/main` and are not regressions from this branch.
- v8x source-compile js2wasm integration: 1/1 passed.
- v8x compiler-free AOT integration with an invalid compiler path: 1/1
  passed; the test observes one module load, one cached module, two isolated
  instantiations, and exact value-level `Deno.cwd()` host-call counts.
- Compiler-free dependency audit: no `wasmtime-cranelift` or
  `cranelift-codegen`. Apple-arm64 stripped test runtime: 1,768,024 bytes;
  the 1,434,192-byte precompiled fixture is the earlier `Deno.cwd()` proof, not
  the current Deno-core artifact.
- Vendored simdutf suite: 14/14 passed.
- Unchanged `deno_core` Rust consumer check and strict runtime: passed with
  v8x's Wasmtime 47.0.3 backend.
- Repository TypeScript typecheck: passed.
- Focused Prettier check: passed.
- v8x base-feature `js2wasm_spike` integration test target: compiles after
  correctly gating the ignored raw-bootstrap diagnostic on
  `js2wasm_runtime_compile`.
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
4. Re-run the exact compiler artifact, precompile, and strict six-line Deno
   proof as positive controls before widening the bridge.
5. Select one additional unchanged-Deno workload and measure its next executed
   semantic boundary, value-level effect, host-import calls, and memory—not only
   a smaller diagnostic-symbol inventory.
6. File each newly discovered independent defect as its own `plan/issues`
   markdown record before widening the implementation.
