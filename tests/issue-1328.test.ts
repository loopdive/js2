// #1328 — RegExp Symbol.match / matchAll protocol spec compliance
//
// The match result returned from the host RegExp engine arrives in Wasm as an
// `externref`. `Array.isArray(result)` was resolved purely at compile time from
// the TypeScript type, which is `externref` for these values, so it wrongly
// emitted a constant `false`. Several test262 cases under
// `built-ins/RegExp/prototype/Symbol.match` and `String/prototype/match`
// assert `Array.isArray(result)`. The fix routes `externref` arguments through
// a new `__extern_is_array` host predicate (§22.2.7.2 result-array shape).

import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.ts";

async function run(src: string, fname = "test"): Promise<unknown> {
  const exports = await compileAndInstantiate(src);
  const fn = (exports as any)[fname];
  if (typeof fn !== "function") throw new Error(`Export ${fname} not a function`);
  return fn();
}

describe("#1328 RegExp Symbol.match / matchAll", () => {
  it("Array.isArray is true for a Symbol.match result", async () => {
    const src = `
      export function test(): string {
        const result: any = /b./[Symbol.match]('abcd');
        return Array.isArray(result) + '|' + result.index + '|' + result.input + '|' + result.length + '|' + result[0];
      }
    `;
    expect(await run(src)).toBe("true|1|abcd|1|bc");
  });

  it("Array.isArray stays true for a real wasm array", async () => {
    const src = `
      export function test(): boolean {
        const a = [1, 2, 3];
        return Array.isArray(a);
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.isArray is false for a non-array externref", async () => {
    const src = `
      export function test(): boolean {
        const o: any = /x/;
        return Array.isArray(o);
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("String.prototype.matchAll dispatches to a user-supplied @@matchAll", async () => {
    const src = `
      export function test(): string {
        const it: any = (String.prototype.matchAll as any).call('-null-', /null/g);
        const first = it.next().value;
        return first[0] + '|' + first.index + '|' + first.input;
      }
    `;
    expect(await run(src)).toBe("null|1|-null-");
  });
});
