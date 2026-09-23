import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("TypeScript comment accumulator callback", () => {
  it.each(["gc", "standalone"] as const)("retains the defaulted accumulator in %s", async (target) => {
    const result = await compile(
      `
      interface Range { pos: number; end: number; kind: number; newline: boolean }
      function iterate<T, U>(cb: (pos: number, end: number, kind: number, newline: boolean, state: T, memo: U | undefined) => U, state: T, initial?: U): U | undefined {
        let accumulator = initial;
        accumulator = cb(0, 8, 3, true, state, accumulator);
        accumulator = cb(10, 17, 2, false, state, accumulator);
        return accumulator;
      }
      function reduce<T, U>(cb: (pos: number, end: number, kind: number, newline: boolean, state: T) => U, state: T, initial: U): U | undefined {
        return iterate(cb, state, initial);
      }
      function append(pos: number, end: number, kind: number, newline: boolean, state: any, ranges: Range[] = []) {
        ranges.push({ pos, end, kind, newline });
        return ranges;
      }
      export function run(): number {
        const ranges = reduce(append, undefined, undefined)!;
        return ranges.length * 100 + ranges[0].end * 10 + ranges[1].kind;
      }
    `,
      { target, skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    if (target === "standalone") expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    (result.importObject as any)?.__setInstance?.(instance);
    expect((instance.exports.run as Function)()).toBe(282);
  });
});
