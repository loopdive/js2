import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("does not import Set_has for a concretely typed optional receiver", async () => {
  const result = await compile(
    `
    function cached(set: Set<number>, key: number): boolean { return set?.has(key) ?? false; }
    export function run(): number {
      const set = new Set<number>(); set.add(17);
      return cached(set, 17) && !cached(set, 23) ? 1 : -1;
    }
  `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(((await WebAssembly.instantiate(module, {})).exports.run as () => number)()).toBe(1);
});

it.each(["Set", "ReadonlySet"])("runs the parser's optional %s lookup shape", async (setType) => {
  const result = await compile(
    `
    let notParenthesizedArrow: ${setType}<number> | undefined;
    function cached(tokenPos: number): boolean {
      if (notParenthesizedArrow?.has(tokenPos)) return true;
      return false;
    }
    export function run(): number {
      if (cached(17)) return -1;
      const values = new Set<number>(); values.add(17);
      notParenthesizedArrow = values;
      if (!cached(17) || cached(23)) return -2;
      return 1;
    }
  `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(((await WebAssembly.instantiate(module, {})).exports.run as () => number)()).toBe(1);
});

it("deletes once through an optional captured Set receiver", async () => {
  const result = await compile(
    `
    let reads = 0;
    const set = new Set<number>();
    function receiver(): Set<number> | undefined { reads++; return set; }
    export function run(): number {
      set.add(17);
      if (receiver()?.delete(17) !== true || reads !== 1 || set.has(17)) return -1;
      if (receiver()?.delete(17) !== false || reads !== 2) return -2;
      return 1;
    }
  `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(((await WebAssembly.instantiate(module, {})).exports.run as () => number)()).toBe(1);
});

it.each(["undefined", "null", "new Set<number>()"])(
  "runs optional Set.has with %s without imports",
  async (initial) => {
    const result = await compile(
      `
    let set: Set<number> | null | undefined = ${initial};
    let receivers = 0, argumentsRead = 0;
    function receiver(): Set<number> | null | undefined { receivers++; return set; }
    function key(): number { argumentsRead++; return 17; }
    export function run(): number {
      const first = receiver()?.has(key());
      if (receivers !== 1 || argumentsRead !== ${initial.startsWith("new") ? 1 : 0}) return -1;
      if (first !== ${initial.startsWith("new") ? "false" : "undefined"}) return -2;
      set = new Set<number>(); set.add(17);
      if (receiver()?.has(key()) !== true) return -3;
      return 1;
    }
  `,
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  },
);
