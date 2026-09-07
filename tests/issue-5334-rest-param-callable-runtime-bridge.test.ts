// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5334 — a rest-parameter function value reached through a typed callable
// slot had its trailing `...args` vec marshalled as an ordinary positional
// formal, so call argument 0 (a string) was `ref.cast` to `$__vec_externref`
// and the call trapped `illegal cast`.
//
// The root of it is a genuine ambiguity: `function spy(...args)` and
// `function g(xs: any[])` lift to the SAME funcref type, and as captureless
// declarations they share the same wrapper struct, so no per-funcref flag can
// say which reading a shared signature wants. The fix decides at RUNTIME
// (src/codegen/expressions/callable-rest-bridge.ts): closure identity when a
// structurally distinct rest struct is registered, else the shape of the value
// that arrives (`ref.test` against the vec carrier: hit → fixed reading, miss →
// pack). Both the identifier ladder (`onChange(...)` on a captured param) and
// the callable-property ladder (`this._onSuccess(...)`) take it.
//
// WHY `dep.ts` + `main.js`: the trigger is a TYPED callable slot — an untyped
// `cb` param has no call signature and never reaches either ladder — while the
// jest.fn()-shaped spy is untyped JS, exactly the dogfood shape (TypeScript
// library, JavaScript shim). The genuine array parameter `g(xs: any[])` must
// be typed too, or it would not share the spy's funcref type at all.
//
// Every value below is pinned from a run of the fixture; on the parent the
// typed-slot cases either trap `illegal cast` or end in the TypeError
// terminal, and `spy(["ab", "c"])` reports two arguments instead of one.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), "js2-5334-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(join(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

// The TYPED library half: jest-watcher's Prompt (a captured callable param
// invoked from an arrow, plus callable-property fields), jest-matcher-utils'
// Replaceable.forEach, and fixed-arity typed callable slots of 0..3 arguments.
const LIB = `
export type ScrollOptions = { max: number; offset: number };

export class Prompt {
  private _value = "x";
  private _n = -1;
  private _onChange: () => void;
  private _onSuccess: (value: string) => void;
  private _onCancel: () => void;
  constructor() {
    this._onChange = () => {};
    this._onSuccess = () => {};
    this._onCancel = () => {};
  }
  enter(
    onChange: (pattern: string, options: ScrollOptions) => void,
    onSuccess: (pattern: string) => void,
    onCancel: () => void,
  ): void {
    this._value = "";
    this._onChange = () => onChange(this._value, { max: 10, offset: this._n });
    this._onSuccess = onSuccess;
    this._onCancel = onCancel;
    this._onChange();
  }
  put(key: string): void {
    if (key === "ENTER") {
      this._onSuccess(this._value);
    } else if (key === "ESC") {
      this._onCancel();
    } else {
      this._value += key;
      this._onChange();
    }
  }
}

type ReplaceableForEachCallBack = (value: unknown, key: unknown, object: unknown) => void;

export class Replaceable {
  object: any;
  constructor(object: any) { this.object = object; }
  forEach(cb: ReplaceableForEachCallBack): void {
    const keys = Object.keys(this.object);
    for (const k of keys) cb(this.object[k], k, this.object);
  }
}

// A genuine array parameter that lowers to the SAME funcref type as
// \`function spy(...args) { return args.length; }\` — the anti-vacuity control.
export function g(xs: any[]): number {
  return xs.length * 100 + (typeof xs[0] === "string" ? xs[0].length : xs[0]);
}

export function callWith0(cb: () => unknown): unknown { return cb(); }
export function callWith1(cb: (a: string) => unknown): unknown { return cb("a"); }
export function callWith2(cb: (a: string, b: number) => unknown): unknown { return cb("a", 2); }
export function callWith3(cb: (a: string, b: number, c: string) => unknown): unknown { return cb("a", 2, "c"); }
export function callWithStrArray(cb: (xs: any) => unknown): unknown { return cb(["ab", "c"]); }
export function callWithNull2(cb: (a: any, b: string) => unknown): unknown { return cb(null, "data"); }
`;

// The UNTYPED half: a jest.fn()-shaped spy factory (a nested, capturing rest
// function recording into module-level arrays, as the dogfood shim's vi.fn
// does), a capture-free top-level rest declaration, and the drivers.
const ENTRY = `
import { Prompt, Replaceable, callWith0, callWith1, callWith2, callWith3, callWithStrArray, callWithNull2, g } from "./dep.js";

const spyLog = [];
let spyCount = 0;
function fn(implementation) {
  const spyIndex = spyCount++;
  function spy(...args) {
    spyLog.push(spyIndex + ":" + args.length);
    for (let i = 0; i < args.length; i++) spyLog.push(args[i]);
    if (typeof implementation === "function") return implementation.apply(this, args);
  }
  return spy;
}
function drain() { const s = spyLog.join("|"); spyLog.length = 0; return s; }

let top = [];
function spyTop(...args) { top = args; return args.length; }

export function top0() { callWith0(spyTop); return "#" + top.length; }
export function top1() { callWith1(spyTop); return top.join("|") + "#" + top.length; }
export function top2() { callWith2(spyTop); return top.join("|") + "#" + top.length; }
export function top3() { callWith3(spyTop); return top.join("|") + "#" + top.length; }
export function topStrArray() { callWithStrArray(spyTop); return "#" + top.length; }
export function topNull2() { callWithNull2(spyTop); return "#" + top.length + ":" + (top[0] === null) + ":" + top[1]; }
export function controlGStr() { return callWithStrArray(g); }

export function nested1() { const s = fn(); callWith1(s); return drain(); }
export function nested3() { const s = fn(); callWith3(s); return drain(); }
export function nested0() { const s = fn(); callWith0(s); return drain(); }
export function nestedStrArray() { const s = fn(); callWithStrArray(s); return drain(); }
export function nestedImpl() { const s = fn((a, b) => a + "+" + b); const r = callWith2(s); return r + "/" + drain(); }

export function promptChange() {
  const s = fn();
  const p = new Prompt();
  p.enter(s, () => {}, () => {});
  p.put("q");
  return drain();
}
export function promptSuccessCancel() {
  const ok = fn();
  const cancel = fn();
  const p = new Prompt();
  p.enter(() => {}, ok, cancel);
  p.put("t");
  p.put("ENTER");
  p.put("ESC");
  return drain();
}
export function replaceableObject() {
  const s = fn();
  new Replaceable({ a: 1, b: "two" }).forEach(s);
  return drain();
}
`;

let compiled: Promise<WebAssembly.Exports> | undefined;
function exportsOf(): Promise<WebAssembly.Exports> {
  compiled ??= (async () => {
    const result = await compileFixture({ "dep.ts": LIB, "main.js": ENTRY }, "main.js");
    expect(result.success, result.errors?.map((e) => e.message).join("\n")).toBe(true);
    return instantiate(result);
  })();
  return compiled;
}
const call = async (name: string): Promise<unknown> => ((await exportsOf())[name] as () => unknown)();

describe("#5334 rest-param function value through a typed callable slot", () => {
  it("packs every argument into the rest vec for 1, 2 and 3 arguments (values pinned)", async () => {
    // Parent: `illegal cast` on argument 0 for each of these.
    expect(await call("top1")).toBe("a#1");
    expect(await call("top2")).toBe("a|2#2");
    expect(await call("top3")).toBe("a|2|c#3");
  });

  it("packs an empty vec when the slot is called with no argument", async () => {
    // Parent: the `(vec)` wrapper is not admitted for a `() => unknown` slot at
    // all, so the call ends in the TypeError terminal.
    expect(await call("top0")).toBe("#0");
  });

  it("keeps the fixed reading for a genuine array parameter sharing the funcref (anti-vacuity)", async () => {
    // `g(xs: any[])` receives the real `["ab", "c"]`: 2 * 100 + "ab".length.
    expect(await call("controlGStr")).toBe(202);
  });

  it("proves the rest reading by closure identity when the only argument is itself an array", async () => {
    // The value test alone cannot tell `spy(["ab", "c"])` from `g(["ab", "c"])`;
    // the pre-registered rest-marker struct can. Parent answered "#2".
    expect(await call("topStrArray")).toBe("#1");
  });

  it("treats null as a packed argument, not as the vec", async () => {
    // Parent: `ref.cast_null` passed null straight through as `args` and the
    // body trapped dereferencing it.
    expect(await call("topNull2")).toBe("#2:true:data");
  });

  it("records a jest.fn()-shaped nested spy's calls (compiled after the library)", async () => {
    expect(await call("nested1")).toBe("0:1|a");
    expect(await call("nested3")).toBe("1:3|a|2|c");
    expect(await call("nested0")).toBe("2:0");
    expect(await call("nestedStrArray")).toBe("3:2|ab|c");
    expect(await call("nestedImpl")).toBe("a+2/4:2|a|2");
  });

  it("drives jest-watcher's Prompt through both the identifier and the property ladder", async () => {
    // onChange(pattern, options) from the captured param: ["", opts] then ["q", opts].
    expect(await call("promptChange")).toBe("5:2||[object Object]|5:2|q|[object Object]");
    // this._onSuccess(value) with one argument, this._onCancel() with none.
    expect(await call("promptSuccessCancel")).toBe("6:1|t|7:0");
    // Replaceable.forEach: cb(value, key, object) three-wide, per key.
    expect(await call("replaceableObject")).toBe("8:3|1|a|[object Object]|8:3|two|b|[object Object]");
  });
});
