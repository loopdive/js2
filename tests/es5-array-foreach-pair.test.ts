// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 Array.prototype.forEach generic-call edge cases covered by
// 15.4.4.18-3-23 and 15.4.4.18-4-2.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "es5-array-foreach-pair.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports, "standalone output leaked host imports").toEqual([]);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("ES5 Array.prototype.forEach generic-call edge cases (standalone)", () => {
  it("reduces the same constructor instance through its assigned prototype", async () => {
    expect(
      await runStandalone(`export function test() {
        var valueOfAccessed = false;
        var proto = { valueOf: function() { valueOfAccessed = true; return 2; } };
        var Con = function() {};
        Con.prototype = proto;
        var child = new Con();
        var direct = child.valueOf();
        var coerced = Number(child);
        return direct * 100 + coerced * 10 + (valueOfAccessed ? 1 : 0);
      }`),
    ).toBe(221);
  });

  it("reduces the constructor instance after an object-field round trip", async () => {
    expect(
      await runStandalone(`export function test() {
        var valueOfAccessed = false;
        var proto = { valueOf: function() { valueOfAccessed = true; return 2; } };
        var Con = function() {};
        Con.prototype = proto;
        var child = new Con();
        var holder = { length: child };
        var coerced = Number(holder.length);
        return coerced * 10 + (valueOfAccessed ? 1 : 0);
      }`),
    ).toBe(21);
  });

  it("coerces an object-valued length through its inherited valueOf first", async () => {
    expect(
      await runStandalone(`export function test() {
        var testResult = false;
        var valueOfAccessed = false;
        var toStringAccessed = false;
        function callbackfn(val, idx, obj) { testResult = val > 10; }
        var proto = { valueOf: function() { valueOfAccessed = true; return 2; } };
        var Con = function() {};
        Con.prototype = proto;
        var child = new Con();
        child.toString = function() { toStringAccessed = true; return "1"; };
        var obj = { 1: 11, 2: 9, length: child };
        Array.prototype.forEach.call(obj, callbackfn);
        return (testResult ? 1 : 0) + (valueOfAccessed ? 2 : 0) + (toStringAccessed ? 4 : 0);
      }`),
    ).toBe(3);
  });

  it("throws ReferenceError for an unresolved callback before invoking forEach", async () => {
    expect(
      await runStandalone(`export function test() {
        var arr = new Array(10);
        try { arr.forEach(foo); }
        catch (error) { return error instanceof ReferenceError ? 1 : 0; }
        return 0;
      }`),
    ).toBe(1);
  });
});
