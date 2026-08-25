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

```ts
const result = await compileProject("main.ts", { packageCacheDir: ".cache" });
const { instance } = await instantiateLinkedProject(result);
```

`result.importObject` also materializes provider instances, preserving existing
`WebAssembly.instantiate(result.binary, result.importObject)` callers. The
explicit helper creates fresh providers for repeated isolated benchmark runs.
`result.linkPlan` reports `compiledProviders` and `cachedProviders` telemetry.

The first ABI deliberately falls back to deterministic monolithic compilation
for cycles, ambiguous/multiple entrypoints, re-exports/default/namespace
imports, host-dependent providers, and runtime value/class/object exports.
Those boundaries need a stable global/object/closure ABI before they can be
split safely; they must not be routed through `externals`, which can silently
erase a value import.
