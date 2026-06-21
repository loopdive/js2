import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2372 — standalone dynamic-object-receiver representation.
//
// A `const o: any = {}` receiver that is the target of an
// `Object.defineProperty(o, key, descVar)` with a *dynamic* (non-inline-literal)
// descriptor was incorrectly widened to a typed WasmGC struct by the
// empty-object-widening pre-pass. The dynamic define is applied through the
// native `__obj_define_from_desc` `$Object` runtime, but the read-back `o.key`
// lowered to `struct.get` against the (different) widened struct, returning 0.
// The fix suppresses struct-widening for any receiver targeted by a
// dynamic-descriptor define (standalone), keeping it on the `$Object` path so
// write and read are consistent.
async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#2372 — standalone dynamic-descriptor receiver read-back", () => {
  it("reads back a data value defined via a dynamic descriptor variable", async () => {
    const src = `
      export function test(): number {
        const o: any = {};
        const d: any = { value: 42 };
        Object.defineProperty(o, "x", d);
        return o.x;
      }
    `;
    expect(await runStandalone(src)).toBe(42);
  });

  it("hasOwnProperty observes a dynamically-defined property", async () => {
    const src = `
      export function test(): number {
        const o: any = {};
        const d: any = { value: 42 };
        Object.defineProperty(o, "x", d);
        return (o.x === 42 && o.hasOwnProperty("x")) ? 1 : 0;
      }
    `;
    expect(await runStandalone(src)).toBe(1);
  });

  it("reads back a dynamic accessor (getter) descriptor", async () => {
    const src = `
      export function test(): number {
        const o: any = {};
        const d: any = { get: function () { return 9; } };
        Object.defineProperty(o, "x", d);
        return o.x;
      }
    `;
    expect(await runStandalone(src)).toBe(9);
  });

  it("mixed inline + dynamic defines on the same receiver both read back", async () => {
    const src = `
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, "a", { value: 1 });
        const d: any = { value: 42 };
        Object.defineProperty(o, "x", d);
        return (o.a === 1 && o.x === 42) ? 1 : 0;
      }
    `;
    expect(await runStandalone(src)).toBe(1);
  });

  // Regression guards: the struct fast path must remain intact for receivers
  // NOT targeted by a dynamic descriptor.
  it("inline-only defineProperty keeps the struct fast path (read-back works)", async () => {
    const src = `
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, "x", { value: 5 });
        return o.x;
      }
    `;
    expect(await runStandalone(src)).toBe(5);
  });

  it("plain property write/read on the same any-receiver is unaffected", async () => {
    const src = `
      export function test(): number {
        const o: any = {};
        o.y = 5;
        return o.y;
      }
    `;
    expect(await runStandalone(src)).toBe(5);
  });

  it("class-instance field access (typed-struct fast path) is unchanged", async () => {
    const src = `
      class P { x = 7; }
      export function test(): number {
        const p = new P();
        return p.x;
      }
    `;
    expect(await runStandalone(src)).toBe(7);
  });

  // Descriptor-reification cases — the un-annotated `var desc = {...}` shape the
  // test262 ToPropertyDescriptor cluster uses. The descriptor compiles to a
  // typed struct; it is reified into a $Object so __obj_define_from_desc can
  // read it (otherwise it throws a spurious TypeError on the non-$Object desc).
  it("un-annotated var receiver + un-annotated var descriptor (real test262 shape)", async () => {
    const src = `
      export function test(): number {
        var o = {};
        var d = { value: 42 };
        Object.defineProperty(o, "x", d);
        return (o as any).x;
      }
    `;
    expect(await runStandalone(src)).toBe(42);
  });

  it("inferred const receiver + inferred const descriptor reads back", async () => {
    const src = `
      export function test(): number {
        const o = {};
        const d = { value: 7 };
        Object.defineProperty(o, "x", d);
        return (o as any).x;
      }
    `;
    expect(await runStandalone(src)).toBe(7);
  });

  it("typed-struct descriptor with multiple attributes reifies", async () => {
    const src = `
      export function test(): number {
        var o: any = {};
        var d = { value: 5, writable: true, enumerable: true };
        Object.defineProperty(o, "x", d);
        return o.x;
      }
    `;
    expect(await runStandalone(src)).toBe(5);
  });

  it("data+accessor conflict in a reified descriptor still throws TypeError (§6.2.5.6)", async () => {
    const src = `
      export function test(): number {
        var o: any = {};
        var d: any = { value: 1, get: function () { return 1; } };
        var threw = false;
        try {
          Object.defineProperty(o, "foo", d);
        } catch (e) {
          threw = true;
        }
        return threw && !o.hasOwnProperty("foo") ? 1 : 0;
      }
    `;
    expect(await runStandalone(src)).toBe(1);
  });
});
