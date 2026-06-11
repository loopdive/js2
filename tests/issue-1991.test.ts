// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1991 — the `in` operator never consulted the [[Prototype]] chain.
//
// `key in obj` (§13.10.1 → §7.3.12 HasProperty) walks the prototype chain, so
// every object value inherits Object.prototype's members. A WasmGC-struct-backed
// receiver (object literal / array / class instance) arrives at the host
// `__extern_has` as an opaque externref whose `key in obj` can't see
// Object.prototype, so `"toString" in ({} as any)` wrongly returned `false`.
//
// Fix: `__extern_has` recognises the well-known Object.prototype keys for any
// non-null object receiver. Own-property and absent-key results are unchanged.
//
// SCOPE: inherited *user-class* methods (`"m" in (new C() as any)` where `m` is
// on a base class) still return false — that needs a compiled class→method
// registry the runtime can consult, and is left as the harder half of the task.

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function inTest(body: string): Promise<boolean> {
  const exports = (await compileAndInstantiate(`export function test(): boolean { ${body} }`)) as { test(): number };
  return Boolean(exports.test());
}

describe("#1991 `in` consults Object.prototype members", () => {
  it("inherited Object.prototype members are found on an object literal", async () => {
    expect(await inTest('const o: any = { a: 1 }; return "toString" in o;')).toBe(true);
    expect(await inTest('const o: any = { a: 1 }; return "valueOf" in o;')).toBe(true);
    expect(await inTest('const o: any = { a: 1 }; return "hasOwnProperty" in o;')).toBe(true);
    expect(await inTest('const o: any = { a: 1 }; return "constructor" in o;')).toBe(true);
  });

  it("own data properties are still found", async () => {
    expect(await inTest('const o: any = { a: 1 }; return "a" in o;')).toBe(true);
  });

  it("absent properties are still false", async () => {
    expect(await inTest('const o: any = { a: 1 }; return "zzz" in o;')).toBe(false);
  });

  it("arrays see both indices/length and Object.prototype members", async () => {
    expect(await inTest('const a: any = [10, 20]; return "0" in a;')).toBe(true);
    expect(await inTest('const a: any = [10, 20]; return "length" in a;')).toBe(true);
    expect(await inTest('const a: any = [10, 20]; return "toString" in a;')).toBe(true);
  });
});
