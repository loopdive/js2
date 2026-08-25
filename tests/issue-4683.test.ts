// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4683) Runtime object-literal computed keys must perform ToPropertyKey once,
// in source order, while named methods remain callable on the open-object
// representation forced by those keys.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runModule(source: string): Promise<number> {
  const result = await compile(`${source}\nexport function test() { return answer; }`, {
    allowJs: true,
    deferTopLevelInit: true,
    fileName: "issue-4683.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, unknown>;
  if (typeof exports.__module_init === "function") (exports.__module_init as () => void)();
  return (exports.test as () => number)();
}

describe("#4683 computed property key evaluation", () => {
  it("evaluates object keys once and keeps named methods callable", async () => {
    await expect(
      runModule(`
        var counter = 0;
        var key1 = { toString: function() { if (counter++ !== 0) throw new Error("key1"); return "b"; } };
        var key2 = { toString: function() { if (counter++ !== 1) throw new Error("key2"); return "d"; } };
        var object = {
          a() { return "A"; },
          [key1]() { return "B"; },
          c() { return "C"; },
          [key2]() { return "D"; },
        };
        var answer = counter === 2 && object.a() === "A" && object.b() === "B" && object.c() === "C" && object.d() === "D" ? 1 : 0;
      `),
    ).resolves.toBe(1);
  });

  it("uses valueOf once for numeric object keys", async () => {
    await expect(
      runModule(`
        var counter = 0;
        var key1 = { valueOf: function() { if (counter++ !== 0) throw new Error("key1"); return 1; }, toString: null };
        var key2 = { valueOf: function() { if (counter++ !== 1) throw new Error("key2"); return 2; }, toString: null };
        var object = { a: "A", [key1]: "B", c: "C", [key2]: "D" };
        var answer = counter === 2 && object.a === "A" && object[1] === "B" && object.c === "C" && object[2] === "D" ? 1 : 0;
      `),
    ).resolves.toBe(1);
  });

  it("preserves large numeric computed keys without i32 truncation", async () => {
    await expect(
      runModule(`
        var object = {
          12345678900: true,
          b: true,
          1: true,
          a: true,
          [Number.MAX_SAFE_INTEGER]: true,
          12345678901: true,
          4294967294: true,
          4294967295: true,
        };
        var answer = object[Number.MAX_SAFE_INTEGER] === true && object[12345678901] === true && object[-1] !== true ? 1 : 0;
      `),
    ).resolves.toBe(1);
  });

  it("uses undefined returned from a function as the computed key", async () => {
    await expect(
      runModule(`
        function f() {}
        var object = { [f()]: 1 };
        var answer = object[f()] === 1 && object[String(f())] === 1 ? 1 : 0;
      `),
    ).resolves.toBe(1);
  });
});
