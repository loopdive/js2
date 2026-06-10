import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#1629 — dynamic descriptor field presence", () => {
  it("preserves inline value: undefined as the descriptor value", async () => {
    expect(
      await runHost(`
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: undefined, writable: false });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          if (typeof d.value !== "undefined") return 1;
          if (d.value === null) return 2;
          if (d.writable !== false) return 3;
          if (d.enumerable !== false) return 4;
          if (d.configurable !== false) return 5;
          return 0;
        }
      `),
    ).toBe(0);
  });

  it("preserves dynamic value: undefined as a present descriptor field", async () => {
    expect(
      await runHost(`
        export function test(): number {
          const o: any = {};
          const desc = { value: undefined, writable: false };
          Object.defineProperty(o, "x", desc);
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          if (typeof d.value !== "undefined") return 1;
          if (d.value === null) return 2;
          if (d.writable !== false) return 3;
          return 0;
        }
      `),
    ).toBe(0);
  });

  it("preserves get: undefined as a present accessor descriptor field", async () => {
    expect(
      await runHost(`
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { get: undefined });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          if (typeof d.get !== "undefined") return 1;
          if (typeof d.set !== "undefined") return 2;
          if (d.enumerable !== false) return 3;
          if (d.configurable !== false) return 4;
          return 0;
        }
      `),
    ).toBe(0);
  });

  it("treats value: undefined as a present data field", async () => {
    expect(
      await runHost(`
        export function test(): boolean {
          const o: any = {};
          const get = function() { return 1; };
          const desc = { value: undefined, get };
          try {
            Object.defineProperty(o, "x", desc);
            return false;
          } catch (e) {
            return e instanceof TypeError;
          }
        }
      `),
    ).toBe(1);
  });

  it("treats get: undefined as a present accessor field for non-configurable validation", async () => {
    expect(
      await runHost(`
        export function test(): boolean {
          const o: any = {};
          const getter = function() { return 1; };
          const first = { get: getter, configurable: false };
          Object.defineProperty(o, "x", first);

          const redefine = { get: undefined };
          try {
            Object.defineProperty(o, "x", redefine);
            return false;
          } catch (e) {
            return e instanceof TypeError;
          }
        }
      `),
    ).toBe(1);
  });

  it("invokes a referenced getter when a statically typed field is read with dot access", async () => {
    expect(
      await runHost(`
        export function test(): number {
          const getter = function() { return 17; };
          const o = { x: 1 };
          Object.defineProperty(o, "x", { get: getter });
          return o.x;
        }
      `),
    ).toBe(17);
  });

  it("invokes a referenced getter when a statically typed field is read with bracket access", async () => {
    expect(
      await runHost(`
        export function test(): number {
          function getter() { return 23; }
          const o = { x: 1 };
          const key = "x";
          Object.defineProperty(o, "x", { get: getter });
          return o[key];
        }
      `),
    ).toBe(23);
  });

  it("preserves referenced getter identity in getOwnPropertyDescriptor read-back", async () => {
    expect(
      await runHost(`
        export function test(): number {
          const getter = function() { return 31; };
          const o: any = {};
          const desc = { get: getter, configurable: false };
          Object.defineProperty(o, "x", desc);
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.get === getter ? d.get() : 0;
        }
      `),
    ).toBe(31);
  });
});
