// #2739 (part a) — for-in must walk a prototype set via Object.setPrototypeOf
// on a WasmGC struct. §13.7.5.15 EnumerateObjectProperties walks
// [[GetPrototypeOf]]; an opaque struct has no host-observable [[Prototype]], so
// `Object.setPrototypeOf(struct, proto)` previously dropped the link on the
// floor (gc/host arm compiled both args, dropped proto) and the for-in walk's
// `Object.getPrototypeOf(struct)` returned null — the inherited keys never
// enumerated.
//
// Fix: record the link in `_wasmStructProto` via a `__host_set_struct_proto`
// host import (called from the Object.setPrototypeOf gc/host arm), and advance
// the for-in walk through `_structUserProto` (which consults that link).
//
// The constructor-function prototype-chain half (S12.6.4_A6*) and the
// Object.defineProperty array+accessor ordering half are carved to a follow-up.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function forInKeys(body: string): Promise<string> {
  const src = `export function test(): any { ${body} }`;
  const result = (await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
  } as never)) as any;
  expect(result.success, result.errors?.[0]?.message).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);
  const ex = wrapExports(instance.exports, { signatures: result.exportSignatures });
  return ex.test() as string;
}

describe("#2739 (a) — for-in walks a setPrototypeOf prototype chain", () => {
  it("enumerates own keys then the proto's keys (order-property-on-prototype)", async () => {
    // Mirrors test262 language/statements/for-in/order-property-on-prototype.js
    expect(
      await forInKeys(`
        const proto: any = { p4: "p4" };
        const o: any = { p1: "p1", p2: "p2", p3: "p3" };
        Object.setPrototypeOf(o, proto);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("p1,p2,p3,p4,");
  });

  it("walks a multi-level setPrototypeOf chain, own-shadows-proto", async () => {
    expect(
      await forInKeys(`
        const grand: any = { g: 1, shared: "grand" };
        const proto: any = { p: 1, shared: "proto" };
        Object.setPrototypeOf(proto, grand);
        const o: any = { a: 1, shared: "own" };
        Object.setPrototypeOf(o, proto);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("a,shared,p,g,");
  });

  it("setPrototypeOf(o, null) enumerates own keys only", async () => {
    expect(
      await forInKeys(`
        const proto: any = { p4: "p4" };
        const o: any = { p1: "p1", p2: "p2" };
        Object.setPrototypeOf(o, proto);
        Object.setPrototypeOf(o, null);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("p1,p2,");
  });
});

// (#2739 b) — constructor-function prototype chain. `new F()` instances must
// enumerate the ctor's `.prototype` object's enumerable keys after their own
// keys, with own keys (including the typed struct FIELDS) shadowing.
import { buildImports } from "../src/runtime.js";

async function runHost(src: string): Promise<unknown> {
  const r = (await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as never)) as any;
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const imp = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imp);
  if (typeof imp.setInstance === "function") imp.setInstance(instance);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2739 (b) — for-in walks the fnctor constructor-prototype chain", () => {
  // NOTE: these mirror the test262 top-level shape (S12.6.4_A6 / 12.6.4-2).
  // Keep the constructor + `.prototype =` write + `new` at MODULE top level
  // with no `as any` casts — a cast parenthesizes the callee, which routes
  // `new` away from the fnctor path (no __register_fnctor_instance) and the
  // scenario silently stops testing the prototype link.
  it("own keys first, inherited key visits, own field shadows proto value (S12.6.4_A6)", async () => {
    expect(
      await runHost(`function FACTORY() { this.prop = 1; this.hint = "hinted"; }
FACTORY.prototype = { feat: 2, hint: "protohint" };
var inst = new FACTORY();
export function test(): string {
  var accum = "";
  for (var key in inst) accum += key + inst[key];
  return accum;
}`),
    ).toBe("prop1hinthintedfeat2");
  });

  it("inherited reads resolve and own dynamic-key reads shadow the proto", async () => {
    expect(
      await runHost(`function FACTORY() { this.hint = "hinted"; }
FACTORY.prototype = { feat: 2, hint: "protohint" };
var inst = new FACTORY();
export function test(): string {
  var k = "hint";
  return inst.feat + "|" + inst[k] + "|" + inst.hint;
}`),
    ).toBe("2|hinted|hinted");
  });

  it("a non-enumerable OWN property still shadows the proto's enumerable one (12.6.4-2)", async () => {
    expect(
      await runHost(`var proto = { prop: "enumerableValue" };
var ConstructFun = function () {};
ConstructFun.prototype = proto;
var child = new ConstructFun();
Object.defineProperty(child, "prop", { value: "nonEnumerableValue", enumerable: false });
export function test(): string {
  var accessedProp = false;
  for (var p in child) {
    if (p === "prop") accessedProp = true;
  }
  return accessedProp ? "visited" : "skipped";
}`),
    ).toBe("skipped");
  });
});
