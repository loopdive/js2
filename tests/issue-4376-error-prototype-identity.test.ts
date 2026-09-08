import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instantiate(source: string) {
  const result = await compile(source, {
    target: "standalone",
    platform: "deno",
    fileName: "error-prototype.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary as BufferSource, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: any[]) => any>;
}

describe("native Error prototype identity through erased values", () => {
  it.each(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"])(
    "preserves %s prototype identity independently of public properties",
    async (name) => {
      const e = await instantiate(`
        export function make():any { return new ${name}('failure'); }
        export function expected():any { return ${name}.prototype; }
        export function direct():any { return Object.getPrototypeOf(new ${name}('failure')); }
        export function proto(value:any):any { return Object.getPrototypeOf(value); }
        export function rename(value:any):void { value.name='NotTheConstructor'; value.constructor=17; }
      `);
      // Positive control: the existing syntax-specialized path works.
      expect(e.direct()).toBe(e.expected());
      const error = e.make();
      expect(e.proto(error)).toBe(e.expected());
      e.rename(error);
      expect(e.proto(error)).toBe(e.expected());
    },
  );

  it("walks the Error prototype chain through erased values", async () => {
    const e = await instantiate(`
      export function native():any { return TypeError.prototype; }
      export function base():any { return Error.prototype; }
      export function root():any { return Object.prototype; }
      export function proto(value:any):any { return Object.getPrototypeOf(value); }
    `);
    expect(e.proto(e.native())).toBe(e.base());
    expect(e.proto(e.base())).toBe(e.root());
    expect(e.proto(e.root())).toBeNull();
  });

  it("does not confuse renamed harness errors with intrinsic Error", async () => {
    const e = await instantiate(`
      class Test262Error extends Error {}
      export function intrinsic():any { const e:any=new Error("native");e.name="Test262Error";return e; }
      export function harness():any { const e:any=new Test262Error("harness");e.name="Error";return e; }
      export function expected():any { return Error.prototype; }
      export function proto(value:any):any { return Object.getPrototypeOf(value); }
    `);
    expect(e.proto(e.intrinsic())).toBe(e.expected());
    expect(e.proto(e.harness())).not.toBe(e.expected());
  });

  it("keeps ordinary and explicit null-prototype controls", async () => {
    const e = await instantiate(`
      export function ordinary():any { return {}; }
      export function bare():any { return Object.create(null); }
      export function root():any { return Object.prototype; }
      export function proto(value:any):any { return Object.getPrototypeOf(value); }
    `);
    expect(e.proto(e.ordinary())).toBe(e.root());
    expect(e.proto(e.bare())).toBeNull();
  });
});
