// #2175 — first-class RegExp.prototype.exec method values in standalone mode.
//
// The prototype carrier and native closure already exist on upstream/main. The
// bounded slice covered here is the closure body: a value-erased
// `RegExp.prototype.exec.call(re, input)` must use the recovered
// `$NativeRegExp`, return the ordinary capture-array shape, and honor runtime
// `g`/`y` lastIndex semantics without host imports.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-2175-regexp-exec.js",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2175 RegExp.prototype.exec native closure", () => {
  it("returns the capture array through a value-erased .call", async () => {
    expect(
      await runStandalone(`
        var exec = RegExp.prototype.exec;
        export function test() {
          var result = exec.call(/a/, "ba");
          return result !== null && result[0] === "a" && result.index === 1 && result.input === "ba" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("selects g/y lastIndex behavior from the recovered receiver", async () => {
    expect(
      await runStandalone(`
        var exec = RegExp.prototype.exec;
        export function test() {
          var re = /a/g;
          var first = exec.call(re, "ba");
          var afterFirst = re.lastIndex;
          var second = exec.call(re, "ba");
          var afterSecond = re.lastIndex;
          return first !== null && first[0] === "a" && afterFirst === 2 &&
            second === null && afterSecond === 0 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps the native brand check catchable on an incompatible this", async () => {
    expect(
      await runStandalone(`
        var exec = RegExp.prototype.exec;
        export function test() {
          try { exec.call({}, "a"); return 0; }
          catch (error) { return error instanceof TypeError ? 1 : 2; }
        }
      `),
    ).toBe(1);
  });
});
