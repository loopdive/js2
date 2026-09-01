// Entry point: import a TypeScript module *as WebAssembly* through the
// js2wasm loader. Run under Deno:
//
//   deno task start          (from this directory)
//   # or: deno run --allow-read --allow-env main.ts
//
// The `@loopdive/js2` imports inside the loader resolve via this directory's
// `deno.json` import map to the npm package.

import { loadWasmModule } from "./js2wasm-loader.ts";

const mod = await loadWasmModule(new URL("./modules/greet.ts", import.meta.url));

console.log(mod.greet("Deno"));
console.log("add(2, 3) =", mod.add(2, 3));
console.log("fib(10)   =", mod.fib(10));
