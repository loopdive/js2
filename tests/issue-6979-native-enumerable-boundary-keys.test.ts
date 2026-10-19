// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

describe("native enumerable string-key selection over live JS objects", () => {
  let keys: (obj: any) => string;
  let inventory: readonly { name: string; classification: string }[];
  beforeAll(async () => {
    const result = await compile("export function keys(value:any):string{return Object.keys(value).join('|');}", {
      skipSemanticDiagnostics: true,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    inventory = result.hostImportInventory ?? [];
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    keys = (wrapCompiledExports(result, instance) as any).keys;
  });
  it("uses own-key and descriptor primitives instead of a JS key selector", () => {
    expect(inventory.some((e) => e.name === "__boundary_object_keys")).toBe(false);
    expect(inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__boundary_object_own_keys", classification: "value-adapter" }),
        expect.objectContaining({
          name: "__boundary_object_get_own_property_descriptor",
          classification: "value-adapter",
        }),
      ]),
    );
  });
  it("keeps integer/string order and omits inherited, hidden and symbol keys", () => {
    const source = Object.assign(Object.create({ inherited: 1 }), { 20: 1, 3: 1, z: 1, a: 1 });
    Object.defineProperty(source, "hidden", { value: 1 });
    source[Symbol("symbol")] = 1;
    expect(keys(source)).toBe(Object.keys(source).join("|"));
  });
  it("preserves a Proxy's OwnPropertyKeys order", () => {
    const source = new Proxy({ a: 1, b: 2 }, { ownKeys: () => ["b", "a"] });
    expect(keys(source)).toBe("b|a");
  });
  it("never Gets source values, queries symbols, or probes the prototype", () => {
    const events: string[] = [];
    const symbol = Symbol("key");
    const source = new Proxy(
      {},
      {
        ownKeys() {
          events.push("keys");
          return ["hidden", "visible", symbol];
        },
        getOwnPropertyDescriptor(_t, k) {
          events.push(`desc:${String(k)}`);
          return { enumerable: k === "visible", configurable: true };
        },
        get() {
          throw new Error("unexpected Get");
        },
        getPrototypeOf() {
          throw new Error("unexpected prototype");
        },
      },
    );
    expect(keys(source)).toBe("visible");
    expect(events).toEqual(["keys", "desc:hidden", "desc:visible"]);
  });
  it("observes disappearing properties through live descriptors", () => {
    const target: any = { a: 1, b: 2, c: 3 },
      events: string[] = [];
    const source = new Proxy(target, {
      getOwnPropertyDescriptor(t, k) {
        events.push(String(k));
        if (k === "a") Reflect.deleteProperty(t, "b");
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    expect(keys(source)).toBe("a|c");
    expect(events).toEqual(["a", "b", "c"]);
  });
  it("observes descriptor-side changes in enumerability", () => {
    const target = { a: 1, b: 2 };
    const source = new Proxy(target, {
      getOwnPropertyDescriptor(t, k) {
        if (k === "a") Object.defineProperty(t, "b", { enumerable: false });
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    expect(keys(source)).toBe("a");
  });
  for (const kind of ["ownKeys", "descriptor"] as const) {
    it(`retains an exact ${kind} throw token`, () => {
      const token = {};
      const source = new Proxy(
        {},
        {
          ownKeys() {
            if (kind === "ownKeys") throw token;
            return ["a"];
          },
          getOwnPropertyDescriptor() {
            throw token;
          },
        },
      );
      try {
        keys(source);
        expect.unreachable("must throw");
      } catch (error) {
        expect(error).toBe(token);
      }
    });
  }
  it("keeps sparse array holes absent", () => {
    // biome-ignore lint/suspicious/noSparseArray: a real absent property is the behavior under test
    expect(keys([1, , 3])).toBe("0|2");
  });
});
