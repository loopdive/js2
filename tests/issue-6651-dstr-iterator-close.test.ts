// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster G, slice G1 — §13.15.5.2 ArrayAssignmentPattern must evaluate
 * each DestructuringAssignmentTarget's REFERENCE before it steps the iterator,
 * and must run §7.4.9 IteratorClose when the pattern ends abruptly with
 * [[done]] still false.
 *
 * Four of these cases are RED on the branch base (the eager
 * `__array_from_iter_n` materialisation steps first, so `nextCount` is 1 where
 * the spec says 0 and `return()` is never called); three are guards that are
 * green on both sides, including the two negative directions — an
 * all-identifier pattern must keep the old lowering, and an already-exhausted
 * iterator must NOT be stepped again by a rest element.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-g1.js",
    target: "standalone",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("; ")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(
    WebAssembly.Module.imports(module).map((e) => `${e.module}::${e.name}`),
    "the lazy destructuring drive must not add a host import",
  ).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, () => number>;
  exports.__module_init?.();
  return exports.test!();
}

async function runHost(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-g1-host.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (v: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = instance.exports as Record<string, () => number>;
  exports.__module_init?.();
  return exports.test!();
}

/** Shared prologue: a plain object whose `@@iterator` hands back a spy. */
const SPY = `
var nextCount = 0;
var returnCount = 0;
var thisOk = 0;
var argCount = -1;
var iterable = {};
var iterator = {
  next: function () { nextCount += 1; return { done: true }; },
  return: function () {
    returnCount += 1;
    if (this === iterator) thisOk = 1;
    argCount = arguments.length;
  }
};
iterable[Symbol.iterator] = function () { return iterator; };
var thrower = function () { throw new RangeError("ref"); };
`;

describe("#6651 G1 — spec-ordered array destructuring assignment + IteratorClose", () => {
  it("evaluates the member target's reference BEFORE the first next(), then closes", async () => {
    // test262 language/expressions/assignment/dstr/array-elem-iter-thrw-close.js
    const answer = await runStandalone(`${SPY}
      export function test() {
        var caught = 0;
        try { 0, [ {}[thrower()] ] = iterable; } catch (e) { caught = 1; }
        return caught * 1000 + nextCount * 100 + returnCount * 10 + thisOk;
      }
    `);
    // caught=1, nextCount=0, returnCount=1, return()'s `this` is the iterator.
    expect(answer).toBe(1011);
  });

  it("passes zero arguments to return()", async () => {
    const answer = await runStandalone(`${SPY}
      export function test() {
        try { 0, [ {}[thrower()] ] = iterable; } catch (e) {}
        return argCount;
      }
    `);
    expect(answer).toBe(0);
  });

  it("lets the ORIGINAL throw win when return() also throws (§7.4.9 step 6)", async () => {
    // test262 …/array-elem-iter-thrw-close-err.js
    const answer = await runStandalone(`${SPY}
      iterator.return = function () { returnCount += 1; throw new TypeError("from return"); };
      export function test() {
        var tag = 0;
        try { 0, [ {}[thrower()] ] = iterable; } catch (e) { tag = e instanceof RangeError ? 1 : 2; }
        return tag * 1000 + nextCount * 100 + returnCount * 10;
      }
    `);
    expect(answer).toBe(1010);
  });

  it("orders a REST target's reference before the drain, and closes on its throw", async () => {
    // test262 …/array-rest-iter-thrw-close.js
    const answer = await runStandalone(`${SPY}
      export function test() {
        var caught = 0;
        try { 0, [ ...{}[thrower()] ] = iterable; } catch (e) { caught = 1; }
        return caught * 1000 + nextCount * 100 + returnCount * 10 + thisOk;
      }
    `);
    expect(answer).toBe(1011);
  });

  it("drains a rest target, skips the close once [[done]], and yields the ORIGINAL rval", async () => {
    // test262 …/array-rest-lref.js — `result = [...obj['ab']] = vals`
    const answer = await runStandalone(`${SPY}
      var obj = {};
      export function test() {
        var vals = iterable;
        var result = [ ...obj['a' + 'b'] ] = vals;
        var sameRval = result === vals ? 1 : 0;
        var emptyRest = obj.ab && obj.ab.length === 0 ? 1 : 0;
        return nextCount * 1000 + returnCount * 100 + sameRval * 10 + emptyRest;
      }
    `);
    // one step (which reports done ⇒ no close), rval preserved, rest is [].
    expect(answer).toBe(1011);
  });

  it("does NOT step again for a rest element that follows an exhausted slot", async () => {
    // Negative direction: `[x, ...obj.r]` over a 0-length iterator steps ONCE.
    const answer = await runStandalone(`${SPY}
      var obj = {};
      export function test() {
        var x = 1;
        0, [ x, ...obj['r'] ] = iterable;
        var emptyRest = obj.r && obj.r.length === 0 ? 1 : 0;
        return nextCount * 100 + returnCount * 10 + emptyRest;
      }
    `);
    expect(answer).toBe(101);
  });

  it("leaves an all-identifier pattern on the existing lowering (host lane, unchanged)", async () => {
    // Guard: no member target ⇒ the drive refuses ⇒ the array fast path stands.
    const source = `
      export function test() {
        var a = 0, b = 0;
        [a, b] = [7, 5];
        return a * 10 + b;
      }
    `;
    expect(await runStandalone(source)).toBe(75);
    expect(await runHost(source)).toBe(75);
  });
});
