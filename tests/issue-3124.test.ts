/**
 * #3124 — inherited member reads through host prototype chains OVER compiled
 * WasmGC structs (`Object.create(<struct>)` receivers).
 *
 * `Object.create(base)` with a compiled struct `base` builds a REAL host
 * object whose `[[Prototype]]` is the opaque struct. V8's native MOP walk
 * cannot see compiled fields (structs present as exotic objects with no own
 * properties), and the struct-aware arms in `__extern_get` /
 * `__extern_method_call` / `__extern_has` only fired for struct RECEIVERS —
 * never a struct mid-chain. Fix: `_protoChainStructResolve` walks the chain
 * manually, resolving own members at each struct hop through the exact
 * direct-receiver machinery (`_resolveHostField`: accessors → sidecar →
 * `__sget_*` → vivified fnctor prototype).
 *
 * Companion fix: the fused `typeof x === "function"` compare (intent
 * `typeof_check`) now recognizes raw closure structs via `__is_closure`,
 * matching `__typeof` (#1594A) and the standalone `__typeof_function` (#1896).
 *
 * Out of scope (documented boundary, see the issue file): a method call whose
 * NAME matches a compiled CLASS method (`o.getX()`) never reaches the host —
 * calls.ts statically binds it to `<Class>_<method>` and null-coerces foreign
 * receivers, trapping in-wasm.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    new Uint8Array(result.binary),
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  const ex: any = instance.exports;
  if (imports.setExports) imports.setExports(ex);
  const mi = ex.__module_init;
  if (typeof mi === "function") mi();
  return ex.test();
}

describe("#3124 — inherited reads over Object.create(<compiled struct>) chains", () => {
  it("probe F: inherited function member reads as typeof 'function' and calls", async () => {
    const src = `
var base: any = { greet: function (): number { return 7; } };
var p: any = Object.create(base);
export function test(): number {
  if (typeof p.greet !== "function") return -1;
  return p.greet();
}
`;
    await expect(run(src)).resolves.toBe(7);
  });

  it("probe H: module-global receiver, read in a different exported function", async () => {
    const src = `
var base: any = { greet: function (): number { return 7; } };
var p: any = Object.create(base);
export function test(): number {
  if (typeof p.greet === "function") return p.greet();
  return -1;
}
`;
    await expect(run(src)).resolves.toBe(7);
  });

  it("inherited number data member resolves through the struct hop", async () => {
    const src = `
var base: any = { n: 5 };
var p: any = Object.create(base);
export function test(): number {
  var v: any = p.n;
  if (typeof v !== "number") return -1;
  return v;
}
`;
    await expect(run(src)).resolves.toBe(5);
  });

  it("compiled CLASS instance as proto: inherited field read resolves", async () => {
    const src = `
class Base {
  x: number;
  constructor() { this.x = 42; }
}
const base = new Base();
const o: any = Object.create(base);
export function test(): number {
  var v: any = o.x;
  if (typeof v !== "number") return -1;
  return v;
}
`;
    await expect(run(src)).resolves.toBe(42);
  });

  it("probe K2/L2 regression-lock: getPrototypeOf round-trip reads stay resolved", async () => {
    const src = `
var base: any = { greet: function (): number { return 7; }, n: 5 };
var p: any = Object.create(base);
export function test(): number {
  var proto: any = Object.getPrototypeOf(p);
  if (proto !== base) return -1;
  if (proto.n !== 5) return -2;
  if (typeof proto.greet !== "function") return -3;
  return proto.greet();
}
`;
    await expect(run(src)).resolves.toBe(7);
  });

  it("own property SHADOWS the inherited struct member", async () => {
    const src = `
var base: any = { n: 5 };
var p: any = Object.create(base);
p.n = 9;
export function test(): number {
  return p.n;
}
`;
    await expect(run(src)).resolves.toBe(9);
  });

  it("'in' walks through the struct hop (§7.3.12 HasProperty)", async () => {
    const src = `
var base: any = { greet: function (): number { return 7; } };
var p: any = Object.create(base);
export function test(): number {
  if (!("greet" in p)) return -1;
  if ("missing" in p) return -2;
  return 1;
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("two-level chain: Object.create(Object.create(struct)) still resolves", async () => {
    const src = `
var base: any = { n: 5 };
var mid: any = Object.create(base);
var p: any = Object.create(mid);
export function test(): number {
  var v: any = p.n;
  if (typeof v !== "number") return -1;
  return v;
}
`;
    await expect(run(src)).resolves.toBe(5);
  });

  it("inherited object-literal METHOD call dispatches through the chain arm", async () => {
    const src = `
var base: any = { greet: function (): number { return 7; } };
var p: any = Object.create(base);
export function test(): number {
  return p.greet();
}
`;
    await expect(run(src)).resolves.toBe(7);
  });

  it("missing member through the chain still reads undefined", async () => {
    const src = `
var base: any = { n: 5 };
var p: any = Object.create(base);
export function test(): number {
  var v: any = p.missing;
  return typeof v === "undefined" ? 1 : 0;
}
`;
    await expect(run(src)).resolves.toBe(1);
  });
});
