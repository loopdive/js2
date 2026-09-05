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

`compileProject` compiles supported bare-package edges into real provider
binaries. Requested function declarations keep their direct Wasm function ABI.
Requested primitive values, plain objects, and provider-owned closures use a
deterministic getter field; the consumer rewrites the import to one module-init
assignment. Provider getters and namespace getters are wrapped with the
provider's own callback/export view before being exposed to the consumer, so
object methods and closure calls retain provider identity and lifecycle. The
consumer receives declaration-only stubs and imports the provider under a
content-addressed namespace such as `js2wasm:npm:pkg:<hash>`. Package-to-package
edges are compiled in dependency order, and the binary plus its export/signature
and boundary-kind manifest is cached in `.js2wasm-cache/npm-modules` (or
`packageCacheDir`).

The export analyzer follows exact relative package edges, including named
aliases, `export { fn } from`, `export * from`, and default function
re-exports. It also follows named/default/star re-exports across bare package
edges and preserves provider-before-consumer order in that package DAG.
TypeScript-realpathed npm/pnpm symlinks recover their physical package identity
from the nearest authoritative `package.json`; a physical path does not have to
retain a literal `node_modules` segment. A generated provider facade gives each requested binding a stable
Wasm field and records whether it is a direct function, value getter, or
namespace getter. An unused class or value in the same package does not disable
a function provider. Default values use getter fields; default functions use
the direct declaration/import path in the consumer and provider DAG. Namespace
imports are linked when the complete selected entry surface is unambiguous.

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
and `cachedProviders` telemetry. A cached provider whose embedded manifest is a
strict ABI superset may satisfy a later consumer that requests fewer exports;
the consumer still imports only its declared fields. This prevents package
barrels and benchmark batches from recompiling the same provider merely because
their requested export subsets differ.

The linker still falls back to deterministic monolithic compilation for package
cycles, ambiguous/multiple entrypoints, re-exports outside the exact relative
graph, TypeScript type-position imports whose identity cannot be preserved,
class facades that fail Wasm validation, and targets that cannot defer provider
initialization. Host/runtime imports are link-safe when the provider's generated
import manifest can rebuild its adapter; arbitrary user-supplied capabilities
still need an explicit dependency injection path. Unsupported boundaries must
remain loud fallbacks rather than being routed through `externals`, which can
silently erase a value import.
