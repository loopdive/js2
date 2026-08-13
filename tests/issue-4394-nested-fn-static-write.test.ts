// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — a TOP-LEVEL second-level static write on a function declaration
 * (`assert.deepEqual._compare = …`, the literal harness's deepEqual.js) must
 * survive into `__module_init` in the host/GC lane.
 *
 * `collectDeclarations` drops a top-level assignment whose root identifier is
 * not a module global. #2671 added a keep for `F.<prop> = …` with a BARE
 * identifier receiver, and #3666 added the nested-receiver keep for standalone
 * only — so in the host/GC lane the second-level write compiled to NOTHING,
 * `_compare` silently never existed, and the whole `deepEqual` harness family
 * failed with `TypeError: _compare is not a function`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJs(source: string): Promise<string[]> {
  // `deferTopLevelInit` emits `__module_init` as an export instead of the wasm
  // `start` section, so top-level code runs AFTER `setInstance` has wired the
  // host runtime — the same model the test262 runner uses. Without it the host
  // cannot wrap a WasmGC closure into a callable (no exports yet) and every
  // function-value static dispatch fails for an unrelated timing reason.
  const result = await compile(source, { fileName: "test.js", deferTopLevelInit: true });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const logged: string[] = [];
  const imports = buildImports(result.imports, undefined, result.stringPool) as any;
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    imports.setInstance?.(instance);
    imports.setExports?.(instance.exports);
    const exports = instance.exports as Record<string, unknown>;
    if (typeof exports.__module_init === "function") (exports.__module_init as () => void)();
    if (typeof exports.main === "function") (exports.main as () => void)();
  } finally {
    console.log = originalLog;
  }
  return logged;
}

describe("#4394 — second-level static write on a top-level function", () => {
  it("keeps `F.prop.nested = fn` and dispatches it from inside F.prop", async () => {
    const logged = await runJs(`
function assert(v, m) { if (v !== true) throw new Error(m || "fail"); }
assert.deepEqual = function (a, b) { return assert.deepEqual._compare(a, b); };
assert.deepEqual._compare = function (a, b) { return a === b; };
console.log("same: " + assert.deepEqual(1, 1));
console.log("diff: " + assert.deepEqual(1, 2));
`);
    expect(logged).toContain("same: true");
    expect(logged).toContain("diff: false");
  });

  it("keeps a nested static whose value is an IIFE over mutually-recursive helpers", async () => {
    const logged = await runJs(`
function assert(v, m) { if (v !== true) throw new Error(m || "fail"); }
assert.deepEqual = function (a, b) { return assert.deepEqual._compare(a, b); };
assert.deepEqual.format = function (v) { return String(v); };
assert.deepEqual._compare = (function () {
  var EQUAL = 1;
  var NOT_EQUAL = -1;
  function deepEqual(a, b) { return compareEquality(a, b) === EQUAL; }
  function compareEquality(a, b) { return a === b ? EQUAL : NOT_EQUAL; }
  return deepEqual;
})();
console.log("typeofCompare: " + typeof assert.deepEqual._compare);
console.log("typeofFormat: " + typeof assert.deepEqual.format);
console.log("same: " + assert.deepEqual(1, 1));
console.log("diff: " + assert.deepEqual(1, 2));
`);
    expect(logged).toContain("typeofCompare: function");
    expect(logged).toContain("typeofFormat: function");
    expect(logged).toContain("same: true");
    expect(logged).toContain("diff: false");
  });

  it("still keeps the first-level static write (#2671)", async () => {
    const logged = await runJs(`
function Test262Error(message) { this.message = message || ""; }
Test262Error.thrower = function (m) { throw new Test262Error(m); };
var caught = "none";
try { Test262Error.thrower("x"); } catch (e) { caught = e.message; }
console.log("caught: " + caught);
`);
    expect(logged).toContain("caught: x");
  });
});
