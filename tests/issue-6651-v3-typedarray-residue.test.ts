// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V3 — ES2015 standalone TypedArray residue. Inline programs only
// (the two test262 rows this slice flips include `detachArrayBuffer.js`, whose
// `$262` prelude needs the runtime-eval provider), each the smallest shape of
// one mechanism:
//
//   * `%ArrayIteratorPrototype%.next` over a dynamic view throws a TypeError
//     once the viewed buffer is detached mid-iteration (§23.1.5.2.1 step 6.b);
//   * `ta.set(src)` on an EXTERNREF receiver that holds a buffer-backed view
//     (a script binding next to an `eval`) writes through the shared buffer
//     instead of trapping `illegal cast`;
//   * a static `class S extends <TA>` constructs a real view (`length`,
//     `ArrayBuffer.isView`), not the #3239 identity-only empty vec.
//
// Every case but the last guard fails on the pre-V3 tree (#6651 plan entry
// "2026-10-06 — Slice V3"). The eval program is only COMPILED with `eval` in a
// never-called function: its `js2wasm:runtime-eval` imports are stubbed to throw,
// so no eval engine runs.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runModule(source: string): Promise<number> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports: Record<string, Record<string, unknown>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    const ns = (imports[imp.module] ??= {});
    ns[imp.name] = () => {
      throw new Error(`unexpected import call ${imp.module}::${imp.name}`);
    };
  }
  const instance = await WebAssembly.instantiate(mod, imports as WebAssembly.Imports);
  const ex = instance.exports as { __module_init?: () => void; readResult: () => number };
  ex.__module_init?.();
  return ex.readResult();
}

describe("#6651 V3 — TypedArray residue mechanisms (standalone)", () => {
  it("a dynamic view's keys() iterator throws TypeError after a mid-loop detach", async () => {
    const result = await runModule(`
var __r = 0;
function detach(buf) { buf.__detached__ = true; }
function body(TA) {
  var ta = new TA(5);
  var i = 0;
  try {
    for (let k of ta.keys()) { detach(ta.buffer); i++; }
  } catch (e) {
    if (e instanceof TypeError) __r |= 1;
  }
  if (i === 1) __r |= 2;
}
body(Float64Array);
export function readResult() { return __r; }
`);
    expect(result).toBe(3);
  }, 120_000);

  it("ta.set on an externref-held buffer view writes through the shared buffer", async () => {
    const result = await runModule(`
var __r = 0;
function ev(s) { return eval(s); }
let ab = new ArrayBuffer(4);
let target = new Int8Array(ab, 1);
target.set([5, 6, 7]);
let dv = new DataView(ab);
if (dv.getInt8(1) === 5 && dv.getInt8(3) === 7) __r |= 1;
if (target[2] === 7) __r |= 2;
let other = new Int8Array(3);
other.set([1, 2], 1);
if (other[2] === 2) __r |= 4;
export function readResult() { return __r; }
`);
    expect(result).toBe(7);
  }, 120_000);

  it("a static TypedArray subclass constructs a real view", async () => {
    const result = await runModule(`
var __r = 0;
class S extends Int16Array {}
var s = new S(3);
if (s.length === 3) __r |= 1;
if (ArrayBuffer.isView(s)) __r |= 2;
if (s instanceof Int16Array && s instanceof S) __r |= 4;
s[1] = 7;
if (s[1] === 7 && s.byteLength === 6) __r |= 8;
export function readResult() { return __r; }
`);
    expect(result).toBe(15);
  }, 120_000);

  it("guard: an undetached dynamic-view iterator still runs to completion", async () => {
    const result = await runModule(`
var __r = 0;
function body(TA) {
  var ta = new TA([3, 4, 5]);
  var sum = 0;
  for (let v of ta.values()) sum += v;
  if (sum === 12) __r |= 1;
  var n = 0;
  for (let e of ta.entries()) n += e[0];
  if (n === 3) __r |= 2;
}
body(Int8Array);
export function readResult() { return __r; }
`);
    expect(result).toBe(3);
  }, 120_000);
});
