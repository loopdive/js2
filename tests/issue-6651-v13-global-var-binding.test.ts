// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V13 (#2727) — §9.1.1.4.17 CreateGlobalVarBinding, standalone.
//
// A script's top-level `var` is an own property of the global object. Bare
// `v` reads its wasm module global; a read or write through the global object
// that the compiler cannot resolve statically (the global object reaching a
// sloppy callee as `this`, `globalThis[k]`) must see and update the SAME cell.
// Measured on base: `this.arrayIndex++` inside a plainly-called sloppy function
// produced NaN and the `var` never changed (test262
// `built-ins/Array/from/source-array-boundary.js`).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = `
function check(c, m) { if (!c) throw new Error(m); }
function throwsType(fn) {
  try { fn(); } catch (thrown) { return thrown instanceof TypeError; }
  return false;
}
`;

/** Compile a script standalone and run its top level; "" = no throw, else the message. */
async function run(body: string, strict = false): Promise<string> {
  const result = await compile((strict ? `"use strict";\n` : "") + PRELUDE + body, {
    allowJs: true,
    fileName: "v13.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  try {
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    return "";
  } catch (e) {
    return String((e as { message?: unknown })?.message ?? e);
  }
}

describe("#6651 V13 — script `var` ↔ global-object property (standalone)", () => {
  it("a sloppy plain call reads and writes the var through `this`", async () => {
    expect(
      await run(`
        var arrayIndex = -1;
        function m() { this.arrayIndex++; return this.arrayIndex; }
        check(m() === 0, "first");
        check(arrayIndex === 0, "var sees write");
        arrayIndex = 5;
        check(m() === 6, "second");
        var s = "a";
        function ws() { this.s = "b"; }
        ws();
        check(s === "b", "string write");
      `),
    ).toBe("");
  });

  it("Array.from hands the global object to the mapper (source-array-boundary)", async () => {
    expect(
      await run(`
        var array = [10, 20, 30];
        var arrayIndex = -1;
        function mapFn(value, index) {
          this.arrayIndex++;
          check(value === array[this.arrayIndex], "value");
          check(index === this.arrayIndex, "index");
          return value;
        }
        var a = Array.from(array, mapFn, this);
        check(a.length === 3 && arrayIndex === 2, "visited all");
      `),
    ).toBe("");
  });

  it("computed reads/writes through globalThis hit the same cell", async () => {
    expect(
      await run(`
        var n = 1;
        var k = "n";
        var g = globalThis;
        check(g[k] === 1, "computed read");
        g[k] = 2;
        check(n === 2, "computed write");
        check(Object.keys(g).indexOf("n") >= 0, "keys");
        check(Reflect.deleteProperty(g, "n") === false, "delete is false");
        check(n === 2, "still bound");
      `),
    ).toBe("");
  });

  it("the property reports the §9.1.1.4.17 data descriptor over the live value", async () => {
    expect(
      await run(`
        var v = 1;
        v = 6;
        var d = Object.getOwnPropertyDescriptor(this, "v");
        check(d.value === 6, "value");
        check(d.writable === true && d.enumerable === true && d.configurable === false, "attrs");
        check(d.get === undefined && d.set === undefined, "no accessor halves");
        Object.defineProperty(this, "v", { value: 9 });
        check(v === 9, "define value writes the var");
        var self = this;
        check(throwsType(function () { Object.defineProperty(self, "v", { configurable: true }); }), "reject");
        Object.defineProperty(this, "v", { writable: false });
        check(Object.getOwnPropertyDescriptor(this, "v").writable === false, "non-writable");
        check(this.v === 9, "value kept");
      `),
    ).toBe("");
  });

  it("a strict script binds the same way through a captured global object", async () => {
    expect(
      await run(
        `
        var x = 5;
        var self = this;
        function r() { return self.x; }
        check(r() === 5, "strict read");
        self.x = 6;
        check(x === 6, "strict write");
        check(throwsType(function () { delete self.x; }), "strict delete throws");
      `,
        true,
      ),
    ).toBe("");
  });
});
