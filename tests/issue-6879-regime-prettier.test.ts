// #6879 — the prettier npm-compat row on the native regime
// (`semanticProviders: "native-first"` in a JavaScript environment), and the
// same two defects under --target standalone.
//
// (1) A concise arrow returning `Object.keys(e).filter(...)` failed Wasm
// validation: the native lowering yields the externref vec while the checker's
// `string[]` declares a different vec, and the concise body was not coerced the
// way a block body's `return` is. (2) `Object.getPrototypeOf` read as a value
// (esbuild's CJS interop: `var uo = Object.getPrototypeOf`) threw on call.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Exports = Record<string, (...args: unknown[]) => any>;

async function regime(source: string): Promise<Exports> {
  const result = await compile(source, {
    fileName: "main.mjs",
    skipSemanticDiagnostics: true,
    semanticProviders: "native-first",
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapCompiledExports(result, instance) as Exports;
}

async function standalone(source: string): Promise<Exports> {
  const result = await compile(source, { fileName: "main.mjs", skipSemanticDiagnostics: true, target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Exports;
}

const CONCISE_KEYS = `
var skip = new Set(["tokens", "comments"]);
var Fa = e => Object.keys(e).filter(t => !skip.has(t));
export function count() { return Fa({ a: 1, tokens: 2, b: 3, comments: 4 }).length; }
`;

const PROTO_VALUE = `
var uo = Object.getPrototypeOf;
class A { constructor() { this.x = 1; } }
export function protos() {
  return (uo({}) === Object.prototype ? 1 : 0) + (uo(new A()) === A.prototype ? 10 : 0) + (uo([]) === Array.prototype ? 100 : 0);
}
`;

describe("#6879 prettier on the native regime", () => {
  it("coerces a concise arrow's vec result to its declared return", async () => {
    expect((await regime(CONCISE_KEYS)).count()).toBe(2);
    expect((await standalone(CONCISE_KEYS)).count()).toBe(2);
  });

  it("calls `Object.getPrototypeOf` read as a value", async () => {
    expect((await regime(PROTO_VALUE)).protos()).toBe(111);
    expect((await standalone(PROTO_VALUE)).protos()).toBe(111);
  });
});
