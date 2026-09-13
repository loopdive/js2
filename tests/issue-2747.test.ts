// #2747 (group d) — Reflect.setPrototypeOf(o, p) and `o.__proto__ = p` must
// record the user [[Prototype]] on a WasmGC struct, exactly like
// Object.setPrototypeOf (fixed in #2739 part a). §13.7.5.15
// EnumerateObjectProperties walks [[GetPrototypeOf]]; an opaque struct has no
// host-observable [[Prototype]], so before this fix:
//   - Reflect.setPrototypeOf routed to a `_wrapForHost` wrapper via
//     __reflect_setPrototypeOf and never recorded `_wasmStructProto`, so the
//     inherited keys never enumerated.
//   - `o.__proto__ = p` fell through the generic struct-write, writing
//     `__proto__` as an OWN enumerable data property AND dropping the link.
//
// Fix: route both through the SAME `__host_set_struct_proto` host import the
// Object.setPrototypeOf gc/host arm uses (standalone → native
// __object_setPrototypeOf), so the for-in walk + getPrototypeOf read path
// follow the link. Carve-out of #2747 (d) only; (b)/(c) stay open.
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
  importObject.__setExports?.(instance.exports);
  const ex = wrapExports(instance.exports, { signatures: result.exportSignatures });
  return ex.test() as string;
}

describe("#2747 (d) — Reflect.setPrototypeOf records the prototype link", () => {
  it("for-in enumerates own then proto keys (parity with Object.setPrototypeOf)", async () => {
    expect(
      await forInKeys(`
        const proto: any = { p4: "p4" };
        const o: any = { p1: "p1", p2: "p2", p3: "p3" };
        Reflect.setPrototypeOf(o, proto);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("p1,p2,p3,p4,");
  });

  it("walks a multi-level Reflect.setPrototypeOf chain, own-shadows-proto", async () => {
    expect(
      await forInKeys(`
        const grand: any = { g: 1, shared: "grand" };
        const proto: any = { p: 1, shared: "proto" };
        Reflect.setPrototypeOf(proto, grand);
        const o: any = { a: 1, shared: "own" };
        Reflect.setPrototypeOf(o, proto);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("a,shared,p,g,");
  });

  it("Reflect.setPrototypeOf(o, null) enumerates own keys only", async () => {
    expect(
      await forInKeys(`
        const proto: any = { p4: "p4" };
        const o: any = { p1: "p1", p2: "p2" };
        Reflect.setPrototypeOf(o, proto);
        Reflect.setPrototypeOf(o, null);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("p1,p2,");
  });

  it("Reflect.setPrototypeOf returns a truthy boolean", async () => {
    expect(
      await forInKeys(`
        const o: any = {}; const p: any = { x: 1 };
        return Reflect.setPrototypeOf(o, p) ? "true" : "false";`),
    ).toBe("true");
  });
});

describe("#2747 (d) — `o.__proto__ = p` records the prototype link", () => {
  it("for-in enumerates own then proto keys, NOT a literal `__proto__` key", async () => {
    expect(
      await forInKeys(`
        const proto: any = { p4: "p4" };
        const o: any = { p1: "p1", p2: "p2", p3: "p3" };
        o.__proto__ = proto;
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("p1,p2,p3,p4,");
  });

  it("walks a multi-level `__proto__` chain, own-shadows-proto", async () => {
    expect(
      await forInKeys(`
        const grand: any = { g: 1, shared: "grand" };
        const proto: any = { p: 1, shared: "proto" };
        proto.__proto__ = grand;
        const o: any = { a: 1, shared: "own" };
        o.__proto__ = proto;
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("a,shared,p,g,");
  });

  it("`o.__proto__ = null` enumerates own keys only", async () => {
    expect(
      await forInKeys(`
        const proto: any = { p4: "p4" };
        const o: any = { p1: "p1", p2: "p2" };
        o.__proto__ = proto;
        o.__proto__ = null;
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("p1,p2,");
  });

  it("`o.__proto__ = p` assignment expression evaluates to the RHS", async () => {
    expect(
      await forInKeys(`
        const o: any = {}; const p: any = { x: 1 };
        const r: any = (o.__proto__ = p);
        return r === p ? "same" : "diff";`),
    ).toBe("same");
  });
});
