// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster G, slice G2 — the §13.15.5.2 lazy destructuring drive now also
 * admits element INITIALIZERS (`[a = f()] = it`) and nested patterns, whose
 * evaluation sits between two IteratorSteps; plus the #2001 `$Hole → undefined`
 * read boundary before a for-of default test.
 *
 * Six cases are RED on the branch base (verified by file-copy A/B of the three
 * edited files): the eager `__array_from_iter_n` drain stepped the iterator
 * past every slot and closed it BEFORE the first initializer ran, so the order
 * was `next,next,return,init-a,init-b` and a throwing initializer found no open
 * iterator to close; and an elision under a default bound the raw sentinel.
 * Two are guards green on both sides (NamedEvaluation of anonymous function
 * defaults, a `null` slot that must not take the default).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, standalone: boolean): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: standalone ? "issue-6651-g2.js" : "issue-6651-g2-host.js",
    ...(standalone ? { target: "standalone" as const } : {}),
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("; ")).toBe(true);
  if (standalone) {
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
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (v: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = instance.exports as Record<string, () => number>;
  exports.__module_init?.();
  return exports.test!();
}

/** An iterable whose steps and closes are logged; `n` values, all `undefined`. */
const LOGGED = `
var log = [];
var stepped = 0;
var iterable = {};
iterable[Symbol.iterator] = function () {
  return {
    next: function () { log.push("next"); stepped += 1; return { done: stepped > 5, value: undefined }; },
    return: function () { log.push("return"); return {}; }
  };
};
`;

describe("#6651 G2 — destructuring defaults and nested patterns in the lazy drive", () => {
  it("runs each initializer right after ITS step, and closes the iterator afterwards", async () => {
    const answer = await run(
      `${LOGGED}
      var a, b;
      export function test() {
        [a = (log.push("init-a"), 1), b = (log.push("init-b"), 2)] = iterable;
        return (log.join(",") === "next,init-a,next,init-b,return" ? 100 : 0) + a * 10 + b;
      }`,
      true,
    );
    expect(answer).toBe(112);
  });

  it("closes the iterator when an initializer throws, after exactly one step", async () => {
    const answer = await run(
      `${LOGGED}
      var thrower = function () { throw new RangeError("init"); };
      var a, b;
      export function test() {
        var caught = 0;
        try { [a = thrower(), b] = iterable; } catch (e) { caught = e instanceof RangeError ? 1 : 2; }
        return caught * 100 + (log.join(",") === "next,return" ? 10 : 0);
      }`,
      true,
    );
    expect(answer).toBe(110);
  });

  it("keeps the initializer's throw when the return getter throws too (§7.4.9 step 6)", async () => {
    // test262 language/expressions/assignment/destructuring/default-expr-throws-iterator-return-get-throws.js
    const answer = await run(
      `
      function MyError() {}
      var getterCalls = 0;
      var iterator = {};
      iterator[Symbol.iterator] = function () { return this; };
      iterator.next = function () { return { done: false }; };
      Object.defineProperty(iterator, "return", { get: function () { getterCalls += 1; throw "bad"; } });
      var thrower = function () { throw new MyError(); };
      export function test() {
        var caught = 0;
        try { var a; [a = thrower()] = iterator; } catch (e) { caught = e instanceof MyError ? 1 : 2; }
        return caught * 10 + getterCalls;
      }`,
      true,
    );
    expect(answer).toBe(11);
  });

  it("destructures an array-literal default of a nested pattern (not a tuple carrier)", async () => {
    const answer = await run(
      `${LOGGED}
      var x, y, z;
      export function test() {
        [[x, y] = [1, 2], z = 3] = iterable;
        return x * 100 + y * 10 + z;
      }`,
      true,
    );
    expect(answer).toBe(123);
  });

  it("evaluates a member target's default after the step, writing through the reference", async () => {
    const answer = await run(
      `${LOGGED}
      var obj = {};
      export function test() {
        [obj.a = (log.push("init"), 5), obj["b"] = 6] = iterable;
        return (log.join(",") === "next,init,next,return" ? 100 : 0) + obj.a * 10 + obj.b;
      }`,
      true,
    );
    expect(answer).toBe(156);
  });

  it("maps an elision to undefined before a for-of default tests it (both targets)", async () => {
    // test262 language/statements/for-of/dstr/array-elem-init-assignment.js
    const source = `
      var v2, vNull, vHole, vUndefined, vOob;
      export function test() {
        for ([v2 = 10, vNull = 11, vHole = 12, vUndefined = 13, vOob = 14] of [[2, null, , undefined]]) {}
        return (v2 === 2 ? 10000 : 0) + (vNull === null ? 1000 : 0) + (vHole === 12 ? 100 : 0) +
          (vUndefined === 13 ? 10 : 0) + (vOob === 14 ? 1 : 0);
      }`;
    expect(await run(source, true)).toBe(11111);
    expect(await run(source, false)).toBe(11111);
  });

  it("names anonymous function and class defaults after their binding (guard)", async () => {
    const answer = await run(
      `${LOGGED}
      var f, g, C;
      export function test() {
        [f = function () {}, g = () => 0, C = class {}] = iterable;
        return (f.name === "f" ? 100 : 0) + (g.name === "g" ? 10 : 0) + (C.name === "C" ? 1 : 0);
      }`,
      true,
    );
    expect(answer).toBe(111);
  });

  it("does not apply a default to a null slot (guard)", async () => {
    const answer = await run(
      `
      var iterable = {};
      iterable[Symbol.iterator] = function () {
        var n = 0;
        return { next: function () { n += 1; return { done: n > 1, value: null }; } };
      };
      var a;
      export function test() {
        [a = 5] = iterable;
        return a === null ? 1 : 0;
      }`,
      true,
    );
    expect(answer).toBe(1);
  });
});
