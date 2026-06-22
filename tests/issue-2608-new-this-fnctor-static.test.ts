// #2608 — `new this(...)` inside an fnctor (function-style constructor) STATIC
// method does not resolve `this` to the constructor and/or mis-forwards its
// args. This is compiled acorn's 4th dogfood blocker: acorn's
// (re-allocated from a hand-picked #2586 that collided with
//  2586-standalone-arrayfrom-map.md on main — #2531 hand-pick race)
// `Parser.parse = function(input, options){ return new this(options, input).parse() }`
// produces a Parser with an EMPTY `this.input`, so the tokenizer scans no
// characters and `parseTopLevel` loops forever.
//
// Minimal repro: a static method `Fn.make = function(x,y){ return new this(x,y) }`.
// `new Fn(x,y)` (by identifier) works; `new this(x,y)` throws
// "is not a constructor" because by the time it reaches `compileNew`, `this`
// has been rewritten from `ThisKeyword` to an `Identifier`, so the #1679
// `new this` arm (new-super.ts) is skipped and the callee drops to the generic
// dynamic-`new` path on a non-constructible wrapped-closure externref.
//
// SKIPPED until the fix lands (see plan/issues/2608-...md for the fix
// direction: resolve the rewritten-`this` callee to the enclosing fnctor ctor
// + forward args in order to `<Class>_new`).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2586 — `new this(...)` in an fnctor static method", () => {
  it("baseline: static method with `new Fn(x,y)` (by identifier) works", async () => {
    const exp = await run(`
      // @ts-nocheck
      var Parser = function Parser(a, b) { this.a = a; this.b = b; };
      Parser.makeIdent = function (x, y) { return new Parser(x, y); };
      export function probe() { return Parser.makeIdent("opt", "inp").b; }
    `);
    expect(exp.probe()).toBe("inp");
  });

  it.skip("`new this(x, y)` in a static method constructs with both args (acorn shape)", async () => {
    const exp = await run(`
      // @ts-nocheck
      var Parser = function Parser(a, b) { this.a = a; this.b = b; };
      Parser.makeNew = function (x, y) { return new this(x, y); };
      Parser.parse = function (input, options) { return new this(options, input).b; };
      export function probeNewThis() { return Parser.makeNew("opt", "inp").b; }
      export function probeAcornShape() { return Parser.parse("theInput", { v: 1 }); }
    `);
    // new this(x,y).b must equal the SECOND arg, and the acorn-shape
    // parse(input,options) → new this(options,input) must put `input` in field b.
    expect(exp.probeNewThis()).toBe("inp");
    expect(exp.probeAcornShape()).toBe("theInput");
  });
});
