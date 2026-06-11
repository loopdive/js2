import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-1818.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

describe("#1818 - primitive parameter defaults do not fire for falsy arguments", () => {
  it("direct boolean and i32 calls distinguish false/0 from omitted args", async () => {
    expect(
      await run(`
        type i32 = number;
        function defaultBool(): boolean { return true; }
        function defaultI32(): i32 { return 5; }
        function boolValue(flag: boolean = defaultBool()): number { return flag ? 1 : 0; }
        function intValue(value: i32 = defaultI32()): number { return value; }
        export function test(): number {
          return boolValue(false) * 1000 + boolValue() * 100 + intValue(0) * 10 + intValue();
        }
      `),
    ).toBe(105);
  });

  it("arrow closures distinguish false/0 from omitted args", async () => {
    expect(
      await run(`
        type i32 = number;
        function defaultBool(): boolean { return true; }
        function defaultI32(): i32 { return 5; }
        const boolValue = (flag: boolean = defaultBool()): number => flag ? 1 : 0;
        const intValue = (value: i32 = defaultI32()): number => value;
        export function test(): number {
          return boolValue(false) * 1000 + boolValue() * 100 + intValue(0) * 10 + intValue();
        }
      `),
    ).toBe(105);
  });

  it("class methods and constructors distinguish false/0 from omitted args", async () => {
    expect(
      await run(`
        type i32 = number;
        function defaultBool(): boolean { return true; }
        function defaultI32(): i32 { return 5; }
        class Box {
          value: number;
          constructor(flag: boolean = defaultBool()) {
            this.value = flag ? 1 : 0;
          }
          boolValue(flag: boolean = defaultBool()): number { return flag ? 1 : 0; }
          intValue(value: i32 = defaultI32()): number { return value; }
        }
        export function test(): number {
          const box = new Box(false);
          const omitted = new Box();
          return box.value * 10000 + omitted.value * 1000 + box.boolValue(false) * 100 +
            box.boolValue() * 10 + box.intValue(0) + box.intValue();
        }
      `),
    ).toBe(1015);
  });

  it("nested functions with defaults share the argc path with arguments", async () => {
    expect(
      await run(`
        type i32 = number;
        function defaultI32(): i32 { return 5; }
        export function test(): number {
          function inner(value: i32 = defaultI32()): number {
            return arguments.length * 10 + value;
          }
          return inner(0) * 100 + inner();
        }
      `),
    ).toBe(1005);
  });

  it("f64 arrow defaults preserve an explicit NaN argument", async () => {
    expect(
      await run(`
        function defaultNumber(): number { return 5; }
        const value = (x: number = defaultNumber()): number => x !== x ? 7 : x;
        export function test(): number {
          return value(NaN) * 10 + value();
        }
      `),
    ).toBe(75);
  });

  it("explicit undefined still fires f64 defaults without treating NaN as missing", async () => {
    expect(
      await run(`
        function defaultNumber(): number { return 39; }
        function plain(a: number, b: number = defaultNumber()): number {
          return a + b;
        }
        class C {
          method(a: number, b: number = defaultNumber()): number {
            return a + b;
          }
        }
        const arrow = (x: number = defaultNumber()): number => x !== x ? 7 : x;
        export function test(): number {
          return plain(3, undefined, 1) * 1000 + new C().method(4, undefined, 1) * 10 + arrow(NaN);
        }
      `),
    ).toBe(42437);
  });
});
