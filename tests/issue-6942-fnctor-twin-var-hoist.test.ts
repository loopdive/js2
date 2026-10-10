// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6942 — the function-constructor twin `__fnctor_<C>_new` hoisted the ctor
 * body's nested function declarations BEFORE its `var` / `let` locals existed,
 * so a nested declaration capturing a ctor local lost the capture (read back
 * null / 0). Triggered when some `new C()` site compiles before `C`'s own
 * declaration (the twin is then the first to register the nested function).
 * Octane `regexp.js` hit it as `s0[i]` → null inside `runBlock0`.
 *
 * Every case compiles real JS through the public `compile()` on the gc host
 * lane and the standalone lane and is compared with node.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runLane(src: string, lane: "gc" | "standalone"): Promise<unknown> {
  const result = await compile(src, {
    fileName: "repro.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  if (!result.success) throw new Error(`compile failed: ${result.errors.map((e) => e.message).join(" | ")}`);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports.run as () => unknown)();
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports.run as () => unknown)();
}

function runNode(src: string): unknown {
  const ctx = vm.createContext({});
  vm.runInContext(`${src.replace(/^export /gm, "")}\nglobalThis.__r = run;`, ctx);
  return (ctx as { __r: () => unknown }).__r();
}

const CASES: Record<string, string> = {
  // The 7-line repro from the issue (was: TypeError on both lanes).
  "var array captured by a nested declaration": `
function dead() { new C(); }
function C() {
  var s0 = ['a', 'b'];
  function runAll() { return s0[0].length; }
  this.run = runAll;
}
export function run() { var b = new C(); return b.run(); }`,
  // Wrong-value variant (was: 0 instead of 42).
  "number var captured": `
function dead() { new C(); }
function C() { var k = 42; function get() { return k; } this.get = get; }
export function run() { var b = new C(); return b.get(); }`,
  // Octane order: the nested declaration textually precedes the var.
  "nested declaration before the var (Octane Exec/s0 order)": `
var g = null;
function Setup() { g = new C(); }
function C() {
  function block() { return s0 + 1; }
  function runAll() { return block(); }
  var s0 = 5;
  this.run = runAll;
}
export function run() { var b = new C(); return b.run(); }`,
  "let binding captured": `
function dead() { new C(); }
function C() {
  let s0 = ['a', 'b'];
  function runAll() { return s0[0].length; }
  this.run = runAll;
}
export function run() { var b = new C(); return b.run(); }`,
  // Each instance closes over its OWN frame's binding, and sees later writes.
  "per-instance binding, assignment after the declaration": `
function mk(n) { return new C(n); }
function C(n) {
  var k = 0;
  function get() { return k; }
  this.get = get;
  k = n;
}
export function run() { var a = mk(1); var b = new C(2); k = 7; return a.get() + b.get() * 10; }
var k = 100;`,
  // Negative controls — passed before the fix and must keep passing.
  "control: C declared before the second site": `
function C() {
  var s0 = ['a', 'b'];
  function runAll() { return s0[0].length; }
  this.run = runAll;
}
function dead() { new C(); }
export function run() { var b = new C(); return b.run(); }`,
  "control: function-expression method": `
function dead() { new C(); }
function C() { var s0 = ['a', 'b']; this.run = function () { return s0[0].length; }; }
export function run() { var b = new C(); return b.run(); }`,
  "control: nested declaration without captures": `
function dead() { new C(); }
function C() { function get() { return 3; } this.get = get; }
export function run() { var b = new C(); return b.get(); }`,
  "control: ctor param shadows an outer binding": `
var x = 5;
function dead() { new C(1); }
function C(x) { function get() { return x; } this.get = get; }
export function run() { var b = new C(9); return b.get() + x; }`,
};

describe("#6942 fnctor twin hoists var/let before nested function declarations", () => {
  for (const [name, src] of Object.entries(CASES)) {
    const expected = runNode(src);
    for (const lane of ["gc", "standalone"] as const) {
      it(`${name} [${lane}] → ${String(expected)}`, async () => {
        expect(await runLane(src, lane)).toBe(expected);
      });
    }
  }
});
