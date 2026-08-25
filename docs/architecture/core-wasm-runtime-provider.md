# Core-Wasm runtime provider

The `js2wasm:runtime` namespace is the first shared-store provider shipped by
#2527. It currently owns the native number-format helpers:

```text
number_toString          (f64)       -> externref
number_toString_radix    (f64, f64)  -> externref
number_toFixed           (f64, f64)  -> externref
number_toPrecision       (f64, f64)  -> externref
number_toExponential     (f64, f64)  -> externref
```

The `externref` result is the existing native-string carrier ABI: consumers
recover their local canonical `$AnyString` with the same conversion sequence
used by the in-module implementation. The provider and consumer both retain
the complete ABI-v2 recursive GC type group, and the compiler verifies that
group directly from the emitted type section. If Binaryen changes that group,
the optimizer output is rejected and the unoptimized bytes are retained.

## Build

Build and content-address the provider with:

```sh
node scripts/build-runtime-provider.mjs --output .cache/js2wasm-runtime.wasm
```

The cache key includes the compiler bundle hash, compile options, and provider
source. The script rejects imports, missing exports, stale ABI metadata, and
invalid Wasm before publishing the artifact. A provider cache miss compiles
once; consumers never compile the provider as a side effect of linking.

## Consume

Pass the provider namespace explicitly when compiling a native-string module:

```ts
const result = await compile(source, {
  nativeStrings: true,
  link: ["js2wasm:runtime"],
});
```

Instantiate the provider and consumer in the same store:

```ts
const provider = await WebAssembly.instantiate(providerBytes, {});
const imports = result.importObject ?? {};
imports["js2wasm:runtime"] = provider.instance.exports;
const consumer = await WebAssembly.instantiate(result.binary, imports);
```

The link is opt-in until the artifact is provisioned. A module that does not
list `js2wasm:runtime` keeps the existing in-module formatter implementation;
the compiler never emits an unsatisfied runtime import by default.

## npm package providers

`compileProject` now has a conservative function-only package linker. A bare
package whose selected entry exports directly declared named functions with
primitive-compatible signatures is compiled into a real provider binary. The
consumer receives declaration-only stubs and imports the provider under a
content-addressed namespace such as `js2wasm:npm:pkg:<hash>`. Package-to-package
edges are compiled in dependency order, and the binary plus its export/signature
manifest is cached in `.js2wasm-cache/npm-modules` (or `packageCacheDir`).

Every provider binary carries one canonical-JSON `js2wasm.provider.v1` custom
section. It records the source fingerprint, package/dependency identities,
exports/signatures, deferred initializer, string pool, adapter metadata, and
compiler/linker/rec-group ABI versions. The cache filename is the SHA-256 of
the finalized Wasm bytes. A `<sourceFingerprint>.ref.json` file may accelerate
lookup, but is only an index: cache loading and instantiation decode and
validate the embedded section, and a missing or malformed index is recovered
by scanning provider `.wasm` files.

```ts
const result = await compileProject("main.ts", { packageCacheDir: ".cache" });
const { instance } = await instantiateLinkedProject(result);
```

`result.importObject` also materializes provider instances, preserving existing
`WebAssembly.instantiate(result.binary, result.importObject)` callers. Provider
adapter metadata is retained with the cached artifact, so each provider gets a
fresh host/runtime adapter and its own string pool. Provider top-level work is
emitted as `__module_init`; the linker wires that provider's `setInstance`
callback before invoking the initializer. `instantiateLinkedProject` therefore
creates fresh provider state for every call, which is the lifecycle boundary
used by repeated benchmark runs. `result.linkPlan` reports `compiledProviders`
and `cachedProviders` telemetry.

The first ABI deliberately falls back to deterministic monolithic compilation
for cycles, ambiguous/multiple entrypoints, re-exports/default/namespace
imports, targets that cannot defer provider initialization, and runtime
value/class/object exports. Host/runtime imports are link-safe when the
provider's generated import manifest can rebuild their adapter; arbitrary
user-supplied capabilities still need an explicit dependency injection path.
Those value/object boundaries need a stable global/object/closure ABI before
they can be split safely; they must not be routed through `externals`, which
can silently erase a value import.
