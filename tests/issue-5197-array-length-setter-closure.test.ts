// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

// Reservation/validation probes only: no array literal or element read can
// incidentally reserve Hole. Runtime mutation is covered by the unchanged six.
for (const type of ["any", "any[]"]) {
  it(`setter-only dependency closure (${type})`, async () => {
    const source = `export function setLength(x: ${type}, key: string, value: number): void { x[key] = value; }`;
    const receipt = { source, sha256: createHash("sha256").update(source).digest("hex") };
    try {
      const result = await compile(source, { target: "standalone", nativeStrings: true });
      console.log(JSON.stringify({ ...receipt, success: result.success, errors: result.errors }));
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      const imports = WebAssembly.Module.imports(module);
      console.log(JSON.stringify({ ...receipt, imports }));
      expect(imports).toEqual([]);
      const instance = new WebAssembly.Instance(module, {});
      expect(typeof instance.exports.setLength).toBe("function");
    } catch (error) {
      console.log(JSON.stringify({ ...receipt, failure: String(error) }));
      throw error;
    }
  });
}

for (const [name, body] of [
  [
    "non-writable length",
    `const a = [1, 2, 3];
    Object.defineProperty(a, "length", { writable: false });
    let threw = false;
    try { Object.defineProperty(a, "length", { value: 1 }); } catch (e) { threw = e instanceof TypeError; }
    return threw && a.length === 3 && a[2] === 3 ? 1 : -1;`,
  ],
  [
    "non-configurable last index",
    `const a = [1, 2, 3];
    Object.defineProperty(a, "2", { configurable: false });
    let threw = false;
    try { Object.defineProperty(a, "length", { value: 1 }); } catch (e) { threw = e instanceof TypeError; }
    return threw && a.length === 3 && a[1] === 2 && a[2] === 3 ? 1 : -1;`,
  ],
  [
    "partial numeric deletion survives later regrowth",
    `const a = [1, 2, 3, 4, 5];
    Object.defineProperty(a, "2", { configurable: false });
    let threw = false;
    try { Object.defineProperty(a, "length", { value: 1 }); } catch (e) { threw = e instanceof TypeError; }
    if (!threw || a.length !== 3 || a[1] !== 2 || a[2] !== 3) return -1;
    Object.defineProperty(a, "length", { value: 5 });
    return a[3] === undefined && a[4] === undefined &&
      !Object.prototype.hasOwnProperty.call(a, "3") && !Object.prototype.hasOwnProperty.call(a, "4") ? 1 : -2;`,
  ],
  [
    "partial reference deletion retains own undefined and blocked value",
    `const value = { n: 3 }; const a = [1, undefined, value, "four", "five"];
    Object.defineProperty(a, "2", { configurable: false });
    let threw = false;
    try { Object.defineProperty(a, "length", { value: 1 }); } catch (e) { threw = e instanceof TypeError; }
    if (!threw || a.length !== 3 || a[2] !== value || !Object.prototype.hasOwnProperty.call(a, "1")) return -1;
    Object.defineProperty(a, "length", { value: 5 });
    return a[3] === undefined && a[4] === undefined &&
      !Object.prototype.hasOwnProperty.call(a, "3") && !Object.prototype.hasOwnProperty.call(a, "4") ? 1 : -2;`,
  ],
] as const) {
  it(`refused descriptor shrink: ${name}`, async () => {
    const source = `export function test() { ${body} }`;
    const native = runInNewContext(`"use strict"; (function() { ${body} })()`, {}, { timeout: 5000 });
    expect(native).toBe(1);
    const result = await compile(source, { target: "standalone", nativeStrings: true });
    console.log(
      JSON.stringify({
        name,
        source,
        sha256: createHash("sha256").update(source).digest("hex"),
        native,
        success: result.success,
        errors: result.errors,
      }),
    );
    expect(result.success).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    const actual = (instance.exports.test as () => number)();
    console.log(JSON.stringify({ name, actual, native }));
    expect(actual).toBe(native);
  });
}
