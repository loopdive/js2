import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("runtime-eval primitive prototype companions", () => {
  it.each([
    ['"abc"', '"abc"'],
    ["6", '"6"'],
    ["true", '"true"'],
    ["false", '"false"'],
  ])("reads the native toString through an erased receiver: %s", async (input, expected) => {
    const result = await compile(
      `
      const prototypes = new WeakMap<object, any>();
      function install(realm: object): void {
        prototypes.set(realm, [String.prototype, Number.prototype, Boolean.prototype] as any[]);
      }
      function invoke(value:any, key:any):any {
        return Reflect.apply(value[key],value,[] as any[]);
      }
      export function test():number {
        install({});
        return invoke(${input},"toString") === ${expected} ? 1 : 0;
      }
    `,
      { target: "standalone", fileName: "primitive-prototypes.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = await WebAssembly.compile(result.binary as BufferSource);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    (instance.exports.__module_init as (() => void) | undefined)?.();
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});
