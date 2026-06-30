import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2885 — Standalone descriptor-reflection core: builtin-proto intrinsic
// accessors are now reflectable host-free.
//
// Under `--target standalone`, `Object.getOwnPropertyDescriptor(RegExp.prototype,
// "global")` previously returned `undefined` (the virtual `$NativeProto` is not
// an `$Object`, so the native `__getOwnPropertyDescriptor` found no own entry),
// and the test then derefed `.get` on `undefined` → Wasm trap. This wires:
//   - a `ctx.standalone`-gated builtin-proto accessor SYNTHESIS path in the gOPD
//     call-site (Site 2) backed by the native `__create_accessor_descriptor`,
//   - the §22.2.6 "SameValue(R, %RegExp.prototype%) → undefined" proto-identity
//     arm in the getter closure (Site 1),
//   - a plain `<Builtin>.prototype.<getter>` read that INVOKES the getter (Site 3).
//
// All host-free: the emitted module must declare ZERO imports.

async function compileStandalone(src: string) {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors?.map((e) => e.message)));
  return r;
}

async function runStandalone(src: string): Promise<{ ret: unknown; importCount: number }> {
  const r = await compileStandalone(src);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { ret: (instance.exports.test as () => unknown)?.(), importCount: r.imports.length };
}

describe("#2885 standalone descriptor-reflection core (RegExp pilot)", () => {
  it("gOPD(RegExp.prototype, 'global') returns a proper accessor descriptor", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        const d = Object.getOwnPropertyDescriptor(RegExp.prototype, "global");
        if (d === undefined) return 100;            // was the bug: undefined → trap
        if (typeof (d as any).get !== "function") return 101;
        if ((d as any).set !== undefined) return 102;
        if ((d as any).enumerable !== false) return 103;
        if ((d as any).configurable !== true) return 104;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("get.call(RegExp.prototype) === undefined (§22.2.6 proto-identity arm)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        const g = (Object.getOwnPropertyDescriptor(RegExp.prototype, "global") as any).get;
        return g.call(RegExp.prototype) === undefined ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("plain read RegExp.prototype.global is undefined (Site 3 invokes the getter)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        return (RegExp.prototype as any).global === undefined ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("descriptor synthesis is host-free (zero imports)", async () => {
    const { importCount } = await runStandalone(`
      export function test(): number {
        const d = Object.getOwnPropertyDescriptor(RegExp.prototype, "global");
        return d === undefined ? 0 : 1;
      }
    `);
    expect(importCount).toBe(0);
  });

  it("gOPD on a user-struct receiver still works (typed-receiver fast path unchanged)", async () => {
    const { ret } = await runStandalone(`
      class C { x = 5; }
      export function test(): number {
        const d = Object.getOwnPropertyDescriptor(new C(), "x");
        return (d as any).value;
      }
    `);
    expect(ret).toBe(5);
  });
});
