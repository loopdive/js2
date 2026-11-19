import { readFileSync } from "node:fs";
const L = new WebAssembly.Instance(new WebAssembly.Module(readFileSync("d7.lib.u.wasm")), {});
try { new WebAssembly.Instance(new WebAssembly.Module(readFileSync("d7.bridged.u.wasm")), { "legacy-lib": L.exports as any }); console.log("d7 with shared $__undefined: returned"); }
catch (e) { console.log("d7 with shared $__undefined:", e instanceof WebAssembly.Exception ? "threw" : String(e)); }
