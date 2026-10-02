// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6651 cluster D, slice D6 — the typed read `C.p` of a module-scope assignment cell on
// `class C extends Promise {}`, BEFORE the assignment has run, answers the static inherited from
// `%Promise%` (`src/codegen/promise-subclass-cell-read.ts`).
//
// The five test262 rows `built-ins/Promise/{all,allSettled,any,race}/invoke-resolve-on-
// {promises,values}-every-iteration-of-custom.js` bind `Custom.resolve` BEFORE reassigning it. The
// read lowered to the not-yet-written cell (`null`), so the bound function wrapped `null`, every
// `Custom.resolve(x)` the combinator made answered a non-object, and the drive threw
// `Promise combinator element then is not a function`. Every behaviour case below is RED on the
// slice's base; the two controls (a plain class and a class whose parent is a USER class) are green
// on both by design — neither has `%Promise%` as its class object's [[Prototype]].
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileJs(body: string, target: "standalone" | undefined) {
  const result = await compile(`function id(x) { return x; }\nvar out = 0;\n${body}\n`, {
    fileName: "issue-6651-d6-promise-subclass-cell-read.js",
    ...(target ? { target } : {}),
    allowJs: true,
    skipSemanticDiagnostics: true,
    emitWat: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.success ? "" : result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(
    true,
  );
  if (!result.success) throw new Error("compile failed");
  return result;
}

async function runStandalone(body: string): Promise<number> {
  const result = await compileJs(`${body}\nexport function test() { __drain_microtasks(); return out; }`, "standalone");
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, "the inherited cell read must stay host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

/** The shape of the five test262 rows, parameterised by combinator and element kind. */
function customResolveRow(method: string, values: string): string {
  return `
class Custom extends Promise {}
let values = ${values};
let cresolveCallCount = 0;
let presolveCallCount = 0;
let boundCustomResolve = Custom.resolve.bind(Custom);
let boundPromiseResolve = Promise.resolve.bind(Promise);
Custom.resolve = function (...args) {
  cresolveCallCount += 1;
  return boundCustomResolve(...args);
};
Promise.resolve = function (...args) {
  presolveCallCount += 1;
  return boundPromiseResolve(...args);
};
Promise.${method}.call(Custom, values).then(
  function () { out = 100 + presolveCallCount * 10 + cresolveCallCount; },
  function () { out = -1; },
);`;
}

describe("#6651 D6 — a Promise subclass's assignment cell read before its write (standalone)", () => {
  for (const method of ["all", "allSettled", "race"]) {
    it(`Promise.${method}.call(Custom, promises) calls the user's Custom.resolve for every element`, async () => {
      const out = await runStandalone(
        customResolveRow(method, "[Promise.resolve(1), Promise.resolve(1), Promise.resolve(1)]"),
      );
      expect(out).toBe(103);
    });
  }

  it("Promise.any.call(Custom, values) with plain values fulfils after three Custom.resolve calls", async () => {
    const out = await runStandalone(customResolveRow("any", "[1, 1, 1]"));
    expect(out).toBe(103);
  });

  it("the read before the write IS %Promise.resolve%; after the write it is the written value", async () => {
    const out = await runStandalone(`
class Custom extends Promise {}
var before = Custom.resolve;
var sameBefore = before === Promise.resolve;
var typeBefore = typeof before;
var mine = function (v) { return v; };
Custom.resolve = mine;
out = (sameBefore ? 100 : 0) + (typeBefore === "function" ? 10 : 0) + (Custom.resolve === mine ? 1 : 0);`);
    expect(out).toBe(111);
  });

  it("a bound pre-write read builds a thenable", async () => {
    const out = await runStandalone(`
class Custom extends Promise {}
var bound = Custom.resolve.bind(Custom);
var p = id(bound(1));
// Returns the bound read, as the test262 rows do (a \`return 0\` would make a JS file's inferred
// expando type \`() => number\` and coerce the result).
Custom.resolve = function (v) { return bound(v); };
out = (typeof p === "object" && p !== null ? 10 : 0) + (typeof p.then === "function" ? 1 : 0);`);
    expect(out).toBe(11);
  });

  it("control: a plain class keeps its pre-write read (no %Promise% fallback)", async () => {
    const out = await runStandalone(`
class K {}
var before = K.resolve;
K.resolve = function () { return 0; };
out = before === undefined || before === null ? 1 : 2;`);
    expect(out).toBe(1);
  });

  it("control: the gc lane and a plain class keep the bare cell read; a standalone Promise subclass gains the fallback", async () => {
    const promiseBody = `class Custom extends Promise {}\nvar before = Custom.resolve;\nCustom.resolve = function () { return 0; };\nexport function test() { return 0; }`;
    const plainBody = `class K {}\nvar before = K.resolve;\nK.resolve = function () { return 0; };\nexport function test() { return 0; }`;
    const guardedReads = async (body: string, target: "standalone" | undefined, cell: string): Promise<number> => {
      const wat = (await compileJs(body, target)).wat ?? "";
      const decls = wat.split("\n").filter((line) => /^\s*\(global \$|^\s*\(import [^\n]*\(global /.test(line));
      const index = decls.findIndex((line) => line.includes(`$__static_${cell} `));
      expect(index, `global $__static_${cell} is declared`).toBeGreaterThanOrEqual(0);
      const guard = new RegExp(`global\\.get ${index}\\s+ref\\.is_null\\s+\\(if \\(result externref\\)`, "g");
      return (wat.match(guard) ?? []).length;
    };
    expect(await guardedReads(promiseBody, "standalone", "Custom_resolve")).toBe(1);
    expect(await guardedReads(promiseBody, undefined, "Custom_resolve")).toBe(0);
    expect(await guardedReads(plainBody, "standalone", "K_resolve")).toBe(0);
  });
});
