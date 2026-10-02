// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6738 — `new (a || B)()` under `--target standalone` answered null.
//
// lodash-es spells `new (Map || ListCache)` (`_mapCacheClear.js`,
// `_stackSet.js`) and `new (memoize.Cache || MapCache)` (`memoize.js`). The
// host-free dynamic-`new` chain admitted only identifier / member / call
// callees, so a callee that SELECTS a constructor value at run time fell to
// the legacy `__new_<name>` terminal, which has no import in standalone.
//
// Row 3 also pins the second half of the fix: the `__native_construct_<N>`
// driver dispatched at the CALL-SITE arity, and `__call_fn_method_<N>` only
// admits closures declaring `<= N` formals — so `new C()` of a
// `function C(entries) { this.clear(); }` value never ran the body (lodash's
// ListCache / MapCache / Hash all have that shape). Row 3's `mk(B)` is the
// pre-existing parameter spelling of the same gap.
//
// Row 4 pins the third: in a runtime-eval CONSUMER program (lodash-es's
// `template` builds `Function(...)` from a runtime string) every top-level
// function declaration is published as the #2928 AOT-callable carrier, which no
// construct arm recognised — `new MapCache()` threw "value is not a
// constructor" on main, and admitting `new (memoize.Cache || MapCache)` moved
// that throw into lodash-es module init.
//
// Each row compares against Node running the same source.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const STANDALONE = {
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
  runtimeEvalProvider: false,
} as const;

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { ...STANDALONE, fileName: "input.js" } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return (exports.run as () => number)();
}

function runNode(source: string): number {
  return (new Function(source.replace("export function run", "return function run")) as () => () => number)()();
}

// The issue's own repro.
const ISSUE_REPRO = `
function ListCache() { this.size = 0; }
ListCache.prototype.set = function (k, v) { this.size++; return this; };
var U;
export function run() {
  var b = new (U || ListCache)();
  return b == null ? 3 : typeof b.set == "function" ? 1 : 2;
}
`;

const SELECTING_SHAPES = `
function ListCache(entries) { this.size = 0; this.e = entries; }
ListCache.prototype.set = function (k, v) { this.size++; return this; };
function Other() { this.tag = 7; }
class A { constructor(x) { this.x = x; } who() { return 1; } }
var U;
var N = null;
var M = Function('return this')().Map;
function probe(f, want) { try { return f() === want ? 1 : 2; } catch (e) { return 9; } }
export function run() {
  var r = 0;
  r = r * 10 + probe(function () { return new (U || ListCache)().set(1, 2).size; }, 1);
  r = r * 10 + probe(function () { return new (N ?? ListCache)(5).e; }, 5);
  r = r * 10 + probe(function () { var c = true; return new (c ? Other : ListCache)().tag; }, 7);
  r = r * 10 + probe(function () { return new (U || A)(3).who(); }, 1);
  r = r * 10 + probe(function () { var m = new (M || ListCache)(); m.set(1, 2); return m.size; }, 1);
  r = r * 10 + probe(function () { return new (U || ListCache)() instanceof ListCache; }, true);
  r = r * 10 + probe(function () { return new (0, Other)().tag; }, 7);
  return r;
}
`;

const UNDER_APPLIED = `
function clear() { this.size = 0; }
function Cache(entries) {
  var index = -1, length = entries == null ? 0 : entries.length;
  this.clear();
  while (++index < length) { this.size++; }
}
Cache.prototype.clear = clear;
function Args(a, b) { this.n = arguments.length; this.bUndef = b === undefined; }
var U;
function mk(C) { return new C(); }
function probe(f, want) { try { return f() === want ? 1 : 2; } catch (e) { return 9; } }
export function run() {
  var r = 0;
  r = r * 10 + probe(function () { return new (U || Cache)().size; }, 0);
  r = r * 10 + probe(function () { return mk(Cache).size; }, 0);
  r = r * 10 + probe(function () { return new (U || Cache)([1, 2]).size; }, 2);
  r = r * 10 + probe(function () { return new (U || Args)(1).n; }, 1);
  r = r * 10 + probe(function () { return new (U || Args)(1).bUndef; }, true);
  return r;
}
`;

// A two-module graph whose entry holds a (never-run) runtime-eval site.
const CARRIER_MODULES: Record<string, string> = {
  "mc.js": `
function MC(entries) { var n = entries == null ? 0 : entries.length; this.clear(); this.n = n; }
MC.prototype.clear = function () { this.size = 0; };
export default MC;
`,
  "entry.js": `
import MC from "./mc.js";
function mk(s) { return Function("a", s); }
export function useMk() { return mk("return a"); }
var U;
export function run() {
  var a = new (U || MC)();
  var b = new MC([1, 2]);
  return (a.size === 0 ? 1 : 2) * 10 + (b.n === 2 && b.size === 0 ? 1 : 2);
}
`,
};

describe("#6738 — standalone `new (a || B)()` with a value-selecting callee", () => {
  it("constructs the issue repro instead of answering null", async () => {
    expect(runNode(ISSUE_REPRO)).toBe(1);
    expect(await runStandalone(ISSUE_REPRO)).toBe(1);
  });

  it("dispatches ||, ??, ?:, comma callees to fnctors, classes and the Map carrier", async () => {
    expect(runNode(SELECTING_SHAPES)).toBe(1_111_111);
    expect(await runStandalone(SELECTING_SHAPES)).toBe(1_111_111);
  });

  it("runs an under-applied constructor body with padded formals and the actual argc", async () => {
    expect(runNode(UNDER_APPLIED)).toBe(11_111);
    expect(await runStandalone(UNDER_APPLIED)).toBe(11_111);
  });

  it("constructs a function published as the runtime-eval AOT-callable carrier", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2wasm-6738-"));
    roots.push(root);
    for (const [name, source] of Object.entries(CARRIER_MODULES)) writeFileSync(join(root, name), source);
    const result = await compileProject(join(root, "entry.js"), {
      ...STANDALONE,
      deferTopLevelInit: true,
    } as Parameters<typeof compileProject>[1]);
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
    const module = new WebAssembly.Module(result.binary!);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const exports = new WebAssembly.Instance(module, {}).exports as Record<string, unknown>;
    (exports.__module_init as (() => void) | undefined)?.();
    expect((exports.run as () => number)()).toBe(11);
  });
});
