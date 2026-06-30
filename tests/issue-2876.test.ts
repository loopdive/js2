import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2876 — Standalone RegExp accessor-reflection cluster.
//
// Builds on #2885 (gOPD builtin-proto accessor synthesis). The dominant lever:
// reflective `.call`/`.apply` on a getter pulled from a builtin-proto accessor
// descriptor. `var get = Object.getOwnPropertyDescriptor(RegExp.prototype,
// "global").get; get.call(R)` — `get` erases to `externref`, so the symbol-keyed
// reflective-call path can't recover it. The compiler now STATICALLY traces the
// receiver's data-flow back to its `gOPD(<Builtin>.prototype, "<getter>").get`
// initializer and call_ref's the funcref stored in the runtime wrapper, threading
// `thisArg → this`. The getter body (#2885) then yields the spec result:
//   - `R === RegExp.prototype` → undefined (boolean flags) / "(?:)" (source) / "" (flags)
//   - a real RegExp instance   → the field value
//   - a non-RegExp `this`      → a catchable TypeError (§22.2.6)
//
// All host-free (zero imports). Native-string getter results are compared
// IN-WASM (a native-string externref cannot cross the JS boundary), so the test
// fn returns an i32 verdict.

async function runStandalone(src: string): Promise<{ ret: unknown; importCount: number }> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors?.map((e) => e.message)));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { ret: (instance.exports.test as () => unknown)?.(), importCount: r.imports.length };
}

describe("#2876 standalone RegExp accessor reflective .call", () => {
  it("boolean flag getter on a real instance returns the boolean", async () => {
    const { ret, importCount } = await runStandalone(`
      export function test(): number {
        const get = (Object.getOwnPropertyDescriptor(RegExp.prototype, "global") as any).get;
        if (get.call(/x/g) !== true) return 10;
        if (get.call(/x/) !== false) return 11;
        return 1;
      }
    `);
    expect(ret).toBe(1);
    expect(importCount).toBe(0);
  });

  it("get.call(RegExp.prototype) → undefined (proto-identity, §22.2.6)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        const get = (Object.getOwnPropertyDescriptor(RegExp.prototype, "ignoreCase") as any).get;
        return get.call(RegExp.prototype) === undefined ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("get.call(<non-RegExp>) throws a catchable TypeError", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        const get = (Object.getOwnPropertyDescriptor(RegExp.prototype, "multiline") as any).get;
        let threw = 0;
        try { get.call(3); } catch (e) { threw++; }
        try { get.call({}); } catch (e) { threw++; }
        try { get.call(undefined); } catch (e) { threw++; }
        return threw === 3 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("source getter: '(?:)' on the proto, the pattern on an instance (§22.2.6.13)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        const get = (Object.getOwnPropertyDescriptor(RegExp.prototype, "source") as any).get;
        if (get.call(RegExp.prototype) !== "(?:)") return 10;
        if (get.call(/abc/) !== "abc") return 11;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("flags getter: '' on the proto, the flag string on an instance (§22.2.6.4)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        const get = (Object.getOwnPropertyDescriptor(RegExp.prototype, "flags") as any).get;
        if (get.call(RegExp.prototype) !== "") return 10;
        if (get.call(/x/gi) !== "gi") return 11;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("inline `gOPD(...).get.call(...)` form (no intermediate variable)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        return (Object.getOwnPropertyDescriptor(RegExp.prototype, "sticky") as any).get.call(/x/y) === true ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("two-hop `var desc = gOPD(...); desc.get.call(...)` form", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        const desc = Object.getOwnPropertyDescriptor(RegExp.prototype, "dotAll");
        return (desc as any).get.call(/x/s) === true ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("does not disturb plain user-function .call", async () => {
    const { ret } = await runStandalone(`
      function add(a: number, b: number): number { return a + b; }
      export function test(): number { return add.call(null, 2, 3); }
    `);
    expect(ret).toBe(5);
  });
});
