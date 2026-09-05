# Deno loader: transparent js2wasm compile-on-import (#642)

Import a plain TypeScript module **as WebAssembly** from Deno. The loader
reads the module's source, compiles it with js2wasm to a WasmGC module,
instantiates it, and hands back directly callable exports:

```ts
import { loadWasmModule } from "./js2wasm-loader.ts";

const mod = await loadWasmModule(new URL("./modules/greet.ts", import.meta.url));
mod.greet("Deno"); // "Hello, Deno!" — computed inside the Wasm module
```

[`modules/greet.ts`](./modules/greet.ts) is ordinary TypeScript — nothing in it
is Wasm-specific. Type annotations are what make ahead-of-time compilation
work, so the loader wants the raw `.ts` source, not transpiled JS.

## Run it

Requires Deno ≥ 2 (npm specifier support). From this directory:

```bash
deno task start
# or: deno run --allow-read --allow-env main.ts
```

Expected output:

```
Hello, Deno!
add(2, 3) = 5
fib(10)   = 55
```

`--allow-read` lets the loader read the module source; `--allow-env` is for the
compiler's environment probes. The `@loopdive/js2` imports resolve through this
directory's [`deno.json`](./deno.json) import map to `npm:@loopdive/js2`.

## How it works

1. `loadWasmModule(specifier)` reads the source (`Deno.readTextFile`, or
   `node:fs/promises` when the same file runs under Node).
2. `compile(source)` from `@loopdive/js2` produces the Wasm binary plus a
   ready-to-pass `importObject` (#1667).
3. `WebAssembly.instantiate(binary, importObject)` + `wrapExports(instance)`
   from `@loopdive/js2/runtime` yield plain-JS-callable exports (strings,
   numbers, and marshalled struct/array returns).
4. Results are cached per specifier; repeat imports reuse the instance.

The compiler and runtime modules are injectable
(`loadWasmModule(url, { compiler, runtime })`), which is how
[`tests/issue-642-deno-loader.test.ts`](../../tests/issue-642-deno-loader.test.ts)
exercises this exact loader against the in-repo compiler under Node/vitest —
the loader logic is CI-validated even though CI has no Deno install.

## Ahead-of-time alternative

Compile-on-import trades startup time for zero build steps. For production,
compile ahead of time and ship only the `.wasm` plus the thin runtime shell:

```bash
npx js2wasm modules/greet.ts -o out          # emits out/greet.wasm
```

then instantiate it with `instantiateWasmStreaming` from
`@loopdive/js2/runtime`. See [`../edge-platform/`](../edge-platform/) for the
standalone (`--target wasi`) deployment story and
[`../native-messaging/`](../native-messaging/) for Deno source (`Deno.stdin` /
`Deno.stdout`) compiled to pure WASI.
