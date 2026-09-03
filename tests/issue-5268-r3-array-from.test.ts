// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268 r3 step R3-1) `Array.from` / `Array.of` as real §23.1.2.1 / §23.1.2.3
 * algorithms under `--target standalone`.
 *
 * Every positive pin here was verified RED on the pre-change tree
 * (`.tmp/basetree`, a `git archive` of the branch base, file-copy A/B per
 * CLAUDE.md): the array-like source threw "value is not iterable", the mapper
 * saw three arguments and never IteratorClosed, and every `.call` form answered
 * "Array.from is not yet implemented in --target standalone".
 *
 * Output is read back host-free through the module's own `__stdout_prepare` /
 * `__stdout_char` exports — the channel the test262 runner uses.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5268-r3-array-from.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // A standalone module that still needs a host import is scored as a failure
  // by the runner, so the pin asserts the import list is empty.
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

describe("#5268 r3 — native Array.from / Array.of (standalone)", () => {
  it("reads an ARRAY-LIKE source through length/index (§23.1.2.1 step 6)", async () => {
    // RED on base: "TypeError: value is not iterable".
    const lines = await runLines(`
      var src = { length: 2, 0: "p", 1: "q" };
      var a = Array.from(src);
      LOG("len=" + a.length);
      LOG("join=" + a.join("|"));
    `);
    expect(lines).toEqual(["len=2", "join=p|q"]);
  });

  it("calls the mapper with exactly (value, index)", async () => {
    // RED on base: the composed drain-then-map route passed (v, i, receiver).
    const lines = await runLines(`
      var seen = [];
      var items = {};
      items[Symbol.iterator] = function () {
        var n = 0;
        return { next: function () { n++; return n < 3 ? { done: false, value: n } : { done: true }; } };
      };
      Array.from(items, function (v, i) { seen.push(arguments.length + ":" + v + ":" + i); return v; });
      LOG(seen.join(","));
    `);
    expect(lines).toEqual(["2:1:0,2:2:1"]);
  });

  it("IteratorCloses when the mapper throws, and propagates the mapper's own error", async () => {
    // RED on base: the drain ran first, so an iterator that never reports done
    // died with "requested new array is too large" and `return` never ran.
    const lines = await runLines(`
      var closeCount = 0;
      var items = {};
      items[Symbol.iterator] = function () {
        return {
          return: function () { closeCount += 1; },
          next: function () { return { done: false }; }
        };
      };
      try {
        Array.from(items, function () { throw new Error("boom"); });
        LOG("no-throw");
      } catch (e) {
        LOG("caught=" + e.message);
      }
      LOG("closeCount=" + closeCount);
    `);
    expect(lines).toEqual(["caught=boom", "closeCount=1"]);
  });

  it("a present but non-callable mapfn is a TypeError, an absent one is not", async () => {
    // The arity travels with the call as its own flag — an externref null is
    // both "no argument" and the compiled `null` literal.
    const lines = await runLines(`
      try { Array.from([1], null); LOG("null-no-throw"); } catch (e) { LOG("null-threw"); }
      try { Array.from([1], 42); LOG("num-no-throw"); } catch (e) { LOG("num-threw"); }
      LOG("plain=" + Array.from([1, 2]).join("|"));
    `);
    expect(lines).toEqual(["null-threw", "num-threw", "plain=1|2"]);
  });

  it("Array.from.call(C, items) constructs through C and Array.from.call(null, …) does not", async () => {
    // RED on base: both answered "Array.from is not yet implemented".
    const lines = await runLines(`
      var calls = 0;
      var C = function () { calls += 1; };
      var items = {};
      items[Symbol.iterator] = function () {
        return { next: function () { return { done: true }; } };
      };
      Array.from.call(C, items);
      LOG("calls=" + calls);
      var r = Array.from.call(null, []);
      LOG("nullLen=" + r.length);
    `);
    expect(lines).toEqual(["calls=1", "nullLen=0"]);
  });

  it("Array.of.call(C, …) runs C with the element count", async () => {
    // RED on base: "Array.of is not yet implemented in --target standalone".
    const lines = await runLines(`
      var seenLen = -1;
      var C = function (n) { seenLen = n; };
      Array.of.call(C, "a", "b", "c");
      LOG("seenLen=" + seenLen);
    `);
    expect(lines).toEqual(["seenLen=3"]);
  });

  it("keeps the string / generator / Set / Map / typed-array fast paths", async () => {
    const lines = await runLines(`
      function* g() { yield 1; yield 2; }
      LOG(Array.from("héllo").join("|"));
      LOG(Array.from([1, 2, 3]).join("|"));
      LOG(Array.from(new Set([1, 2, 2])).join("|"));
      LOG("map=" + Array.from(new Map([[1, "a"]])).length);
      LOG(Array.from(g()).join("|"));
      LOG(Array.from({ length: 3 }, function (_, i) { return i * 2; }).join("|"));
    `);
    expect(lines).toEqual(["h|é|l|l|o", "1|2|3", "1|2", "map=1", "1|2", "0|2|4"]);
  });

  // Round-3 review fixes (2026-09-03). Each was RED on d18dd8673f (the r3
  // step-1 tree): F1 `fin=0`, F2 `undefined,undefined`, F4 `gets=2`.
  it("F1: IteratorClose on an abrupt mapper runs a native generator's finally, in order", async () => {
    const lines = await runLines(`
      var fin = 0, order = "";
      function* wf() { try { order += "y1 "; yield 1; order += "y2 "; yield 2; yield 3; } finally { fin++; order += "FIN "; } }
      try { Array.from(wf(), function (v) { order += "m" + v + " "; if (v === 2) throw new Error("x"); return v; }); }
      catch (e) { order += "caught:" + e.message; }
      LOG("fin=" + fin);
      LOG(order);
      var it = wf(); it.next();
      try { Array.from(it, function () { throw new Error("q"); }); } catch (e) {}
      LOG("done=" + it.next().done);
    `);
    expect(lines).toEqual(["fin=1", "y1 m1 y2 m2 FIN caught:x", "done=true"]);
  });

  it("F2: a closed-struct iterable that also carries length takes the iterator branch", async () => {
    const lines = await runLines(`
      class L2 { constructor() { this.length = 2; } [Symbol.iterator]() { return [6, 7][Symbol.iterator](); } }
      LOG(Array.from(new L2()).join(","));
      LOG(Array.from(new L2(), function (v) { return v + 1; }).join(","));
      var lit = { length: 5, [Symbol.iterator]() { return [8, 9][Symbol.iterator](); } };
      LOG(Array.from(lit).join(","));
      LOG(Array.from("ab", function (v, i) { return v + i; }).join(","));
    `);
    expect(lines).toEqual(["6,7", "7,8", "8,9", "a0,b1"]);
  });

  it("F4: the @@iterator accessor fires exactly once per Array.from call", async () => {
    const lines = await runLines(`
      var c = { n: 0 }; var o = { length: 0 };
      Object.defineProperty(o, Symbol.iterator, { get: function () { c.n++; return function () { return [7][Symbol.iterator](); }; } });
      var r = Array.from(o);
      LOG(r.join(",") + " gets=" + c.n);
    `);
    expect(lines).toEqual(["7 gets=1"]);
  });
});
