// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instr } from "../src/wasm/model/instructions.js";
import * as recipe from "../src/runtime/wasmgc/values/to-primitive-bodies.js";
import { copyToPrimitiveLiteral } from "../src/runtime/wasmgc/values/to-primitive-method-bodies.js";
import { compile } from "../src/index.js";

function allNodes(value: unknown): object[] {
  if (value === null || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(allNodes)];
}
afterEach(async () => {
  await setImmediate();
});

describe("ToPrimitive literal copies", () => {
  it("positive-first control exposes a shallow nested-literal copy", () => {
    const nested: Instr[] = [
      { op: "block", blockType: { kind: "empty" }, body: [{ op: "call", funcIdx: 0x40000001 }] },
    ];
    const first = copyToPrimitiveLiteral(nested),
      second = copyToPrimitiveLiteral(nested);
    expect(first).toEqual(second);
    expect(allNodes(first).some((a) => allNodes(second).some((b) => Object.is(a, b)))).toBe(false);
    const shallowA = nested.map((i) => ({ ...i })),
      shallowB = nested.map((i) => ({ ...i }));
    expect(allNodes(shallowA).some((a) => allNodes(shallowB).some((b) => Object.is(a, b)))).toBe(true);
  });
});

/** Real compiler route: these modules invoke the relocated body through the
 * unchanged legacy reservation/finalization path. This is not C1/C2 ownership. */
type Completion =
  | { kind: "return"; value: number }
  | { kind: "throw"; name: string }
  | { kind: "unclassified-wasm-throw"; name: string; message: string };
function nativeExports(source: string): Record<string, (seed?: number) => number> {
  const exports = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(js, { exports });
  return exports;
}
function nativeCompletion(source: string, seed: number): Completion {
  try {
    return { kind: "return", value: nativeExports(source).run!(seed) };
  } catch (error) {
    return { kind: "throw", name: String((error as { name?: unknown })?.name) };
  }
}
// A transparent observation wrapper leaves each exact case source intact. It
// classifies the one uncaught error family in these cases inside Wasm, where
// the actual native Error carrier is available. Unknown throws/traps stay loud.
const completionObserver = `
let __c1_observed_value = 0;
export function __c1_observe(seed: number): number {
  try { __c1_observed_value = run(seed); return 1; }
  catch (error) { if (error instanceof TypeError) return 2; throw error; }
}
export function __c1_value(): number { return __c1_observed_value; }
`;
function observedCompletion(exports: Record<string, (seed?: number) => number>, seed: number): Completion {
  try {
    const kind = exports.__c1_observe!(seed);
    if (kind === 1) return { kind: "return", value: exports.__c1_value!() };
    if (kind === 2) return { kind: "throw", name: "TypeError" };
    throw new Error(`unknown completion kind ${kind}`);
  } catch (error) {
    return {
      kind: "unclassified-wasm-throw",
      name: String((error as Error)?.name),
      message: String((error as Error)?.message),
    };
  }
}
async function execute(source: string) {
  const wrapped = source + completionObserver;
  const native = nativeCompletion(source, 7);
  expect(observedCompletion(nativeExports(wrapped), 7)).toEqual(native);
  const result = await compile(wrapped, { target: "standalone", fileName: "to-primitive-connected.ts", emitWat: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  const actual = observedCompletion(instance.exports as Record<string, (seed?: number) => number>, 7);
  console.info("ToPrimitive completion", JSON.stringify({ source, native, actual }));
  expect(actual, JSON.stringify({ source, native, actual })).toEqual(native);
}
// The original manual expectations are archived in the local review receipt.
// Every current expected completion comes from the exact native Node fixture.
const connected: [string, string][] = [
  [
    "inherited Symbol getter, original receiver, string hint and real hash/find",
    `
    export function run(seed: number): number {
      const proto: any = {}; let calls=0; let hints=0; let receivers=0;
      const key: any = Object.create(proto); key.prefix = "key";
      Object.defineProperty(proto, Symbol.toPrimitive, {get:function():any {
        calls++; if(this===key) receivers++;
        return function(h:any):any { if(this===key) receivers++; if(h==="string") hints++; return this.prefix+seed; };
      }});
      const bag:any={}; bag[key]=31; const found=bag[key];
      return found===31 && calls===2 && hints===2 && receivers===4 ? 1:0;
    }`,
  ],
  [
    "Symbol result keeps identity through real property-key lookup",
    `
    export function run(seed:number):number {
      const symbol:any=Symbol("key"); const key:any={}; let calls=0;
      key[Symbol.toPrimitive]=function(h:any):any { calls++; return symbol; };
      const bag:any={};bag[key]=seed; return bag[symbol]===seed && calls===1 ? 1:0;
    }`,
  ],
  [
    "default and string hints remain distinct and methods receive the input",
    `
    export function run(seed:number):number {
      const x:any={n:seed};let defaults=0;let strings=0;let receivers=0;
      x[Symbol.toPrimitive]=function(h:any):any { if(this===x)receivers++; if(h==="default")defaults++;if(h==="string")strings++;return h==="string"?"K":this.n;};
      const n=x+1;const text=String(x);return n===seed+1 && text==="K" && defaults===1 && strings===1 && receivers===2 ? 1:0;
    }`,
  ],
  [
    "inherited getter exception precedes all fallback calls",
    `
    export function run(seed:number):number {
      const abrupt:any={value:seed};const proto:any={};let gets=0;let fallback=0;
      Object.defineProperty(proto,Symbol.toPrimitive,{get:function():any {gets++;throw abrupt;}});
      proto.toString=function():any{fallback++;return "bad";};const key:any=Object.create(proto);
      try {const bag:any={};bag[key]=1;return 0;} catch(e:any){return e===abrupt && gets===1 && fallback===0 ? 1:0;}
    }`,
  ],
  [
    "noncallable Symbol method throws before ordinary fallback",
    `
    export function run(seed:number):number {const x:any={};let fallback=0;x[Symbol.toPrimitive]=seed;x.valueOf=function():any{fallback++;return 1;};try{return +x;}catch(e:any){return e instanceof TypeError && fallback===0 ? 1:0;}}
  `,
  ],
  [
    "nonprimitive Symbol result throws exactly after one call",
    `
    export function run(seed:number):number {const x:any={};let calls=0;let fallback=0;x[Symbol.toPrimitive]=function():any{calls++;return {n:seed};};x.valueOf=function():any{fallback++;return 1;};try{return +x;}catch(e:any){return e instanceof TypeError && calls===1 && fallback===0 ? 1:0;}}
  `,
  ],
  [
    "undefined is a primitive method result, not absence",
    `
    export function run(seed:number):number {const x:any={};let first=0;let second=0;x.valueOf=function():any{first++;return undefined;};x.toString=function():any{second++;return "wrong";};const v=x+seed;return v!==v && first===1 && second===0 ? 1:0;}
  `,
  ],
  [
    "null is a primitive method result",
    `
    export function run(seed:number):number {const x:any={};let calls=0;x.valueOf=function():any{calls++;return null;};x.toString=function():any{return "wrong";};return x*seed===0 && calls===1 ? 1:0;}
  `,
  ],
  [
    "wrapper own overrides and two object-returning own methods",
    `
    export function run(seed:number):number {const a:any=new Number(seed);let calls=0;a.valueOf=function():any{calls++;return seed+1;};const first=a*2;const b:any=new Number(seed);b.valueOf=function():any{return {};};b.toString=function():any{return {};};return first===(seed+1)*2 && b*2===seed*2 && calls===1 ? 1:0;}
  `,
  ],
  [
    "array and nominal class conversion retain their distinct drivers",
    `
    class Value {n:number;constructor(n:number){this.n=n;}valueOf():number{return this.n+1;}}
    function reduce(x:any):number{return x*2;}
    export function run(seed:number):number {const a:any=[seed];return reduce(a)===seed*2 && reduce(new Value(seed))===(seed+1)*2 ? 1:0;}
  `,
  ],
  [
    "null and undefined inputs remain primitive identities",
    `
    function reduce(x:any):number{return x*2;}
    export function run(seed:number):number {const nullResult=reduce(null);const undefResult=reduce(undefined);return nullResult===0 && undefResult!==undefResult && seed===7 ? 1:0;}
  `,
  ],
  [
    "ordinary method getter order follows the requested hint",
    `
    export function run(seed:number):number {const x:any={};let log="";Object.defineProperty(x,"valueOf",{get:function():any{log=log+"v";return function():any{return seed;};}});Object.defineProperty(x,"toString",{get:function():any{log=log+"s";return function():any{return "K";};}});const number=x*2;const text=String(x);return number===seed*2 && text==="K" && log==="vs" ? 1:0;}
  `,
  ],
];
describe("C1 ToPrimitive connected legacy emitted-Wasm behavior", () => {
  it.each(connected)("%s", async (_name, source) => {
    await execute(source);
  });
});

it("the actual emitted ToPrimitive body executes: positive first, then a test-only poison prefix", async () => {
  const source = `function reduce(value:any):number {return value*2;} export function run(seed:number):number {const object:any={};object.valueOf=function():number{return seed;};return reduce(object);}`;
  const native = nativeCompletion(source, 7);
  expect(native).toEqual({ kind: "return", value: 14 });
  const control = await compile(source, { target: "standalone", fileName: "to-primitive-live-control.ts" });
  expect(control.success, JSON.stringify(control.errors)).toBe(true);
  const live = new WebAssembly.Instance(new WebAssembly.Module(control.binary), {});
  expect((live.exports.run as (seed: number) => number)(7)).toBe(14);
  const original = recipe.buildToPrimitiveBody;
  const spy = vi
    .spyOn(recipe, "buildToPrimitiveBody")
    .mockImplementation((bindings) => [{ op: "unreachable" }, ...original(bindings)]);
  try {
    const poisoned = await compile(source, { target: "standalone", fileName: "to-primitive-live-control.ts" });
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(poisoned.success, JSON.stringify(poisoned.errors)).toBe(true);
    expect(WebAssembly.validate(poisoned.binary)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(poisoned.binary), {});
    expect(() => (instance.exports.run as (seed: number) => number)(7)).toThrow(/unreachable/);
  } finally {
    spy.mockRestore();
  }
});
