// #3015 — standalone: array predicate methods routed an opaque-externref
// (dynamic function-typed param) callback to the `__call_1_f64` / `__call_2_f64`
// host bridge instead of a native `call_ref`. That import makes a standalone
// (host-free) module non-instantiable, so every such test failed.
//
// Fix (src/codegen/array-methods.ts, setupArrayCallback): when the callback
// value compiles to an opaque `externref` (a function PARAMETER) in standalone
// mode, resolve the callback signature's canonical funcref wrapper
// (getOrCreateFuncRefWrapperTypes — the SAME cache-keyed wrapper the arrow
// value-site registers) and convert the externref to it, so the existing native
// call_ref path runs. Host mode is untouched (branch is `ctx.standalone`-gated)
// and keeps the bridge fast-path (dual-mode principle).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const CALL_BRIDGES = ["__call_1_f64", "__call_1_i32", "__call_2_f64", "__call_2_i32"];

async function runStandalone(src: string): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // No host call-bridge import may remain (the whole point of #3015).
  const importNames = (r.imports ?? []).map((i) => i.name);
  for (const bridge of CALL_BRIDGES) {
    expect(importNames, `standalone module must not import ${bridge}`).not.toContain(bridge);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)?.();
}

describe("#3015 — dynamic function-typed array callback is native in standalone", () => {
  it("some (true / false) via a dynamic param callback", async () => {
    expect(
      await runStandalone(
        `function run(cb:(x:number)=>boolean):boolean{const a=[1,2,3];return a.some(cb);}` +
          `export function test():number{return run(x=>x>2)?1:0;}`,
      ),
    ).toBe(1);
    expect(
      await runStandalone(
        `function run(cb:(x:number)=>boolean):boolean{const a=[1,2,3];return a.some(cb);}` +
          `export function test():number{return run(x=>x>9)?1:0;}`,
      ),
    ).toBe(0);
  });

  it("every via a dynamic param callback", async () => {
    expect(
      await runStandalone(
        `function run(cb:(x:number)=>boolean):boolean{const a=[2,4,6];return a.every(cb);}` +
          `export function test():number{return run(x=>x%2===0)?1:0;}`,
      ),
    ).toBe(1);
  });

  it("forEach accumulates via a dynamic param callback", async () => {
    expect(
      await runStandalone(
        `function run(cb:(x:number)=>void):void{const a=[1,2,3,4];a.forEach(cb);}` +
          `export function test():number{let s=0;run(x=>{s+=x;});return s;}`,
      ),
    ).toBe(10);
  });

  it("map / filter via a dynamic param callback", async () => {
    expect(
      await runStandalone(
        `function run(cb:(x:number)=>number):number[]{const a=[1,2,3];return a.map(cb);}` +
          `export function test():number{return run(x=>x*10)[2];}`,
      ),
    ).toBe(30);
    expect(
      await runStandalone(
        `function run(cb:(x:number)=>boolean):number[]{const a=[1,2,3,4,5];return a.filter(cb);}` +
          `export function test():number{return run(x=>x>2).length;}`,
      ),
    ).toBe(3);
  });

  it("find / findIndex via a dynamic param callback", async () => {
    expect(
      await runStandalone(
        `function run(cb:(x:number)=>boolean):number|undefined{const a=[1,2,3,4];return a.find(cb);}` +
          `export function test():number{return run(x=>x>2) as number;}`,
      ),
    ).toBe(3);
    expect(
      await runStandalone(
        `function run(cb:(x:number)=>boolean):number{const a=[10,20,30];return a.findIndex(cb);}` +
          `export function test():number{return run(x=>x===20);}`,
      ),
    ).toBe(1);
  });

  it("reduce (with and without initial value) via a dynamic param callback", async () => {
    expect(
      await runStandalone(
        `function run(cb:(acc:number,x:number)=>number):number{const a=[1,2,3,4];return a.reduce(cb,0);}` +
          `export function test():number{return run((acc,x)=>acc+x);}`,
      ),
    ).toBe(10);
    expect(
      await runStandalone(
        `function run(cb:(acc:number,x:number)=>number):number{const a=[5,6,7];return a.reduce(cb);}` +
          `export function test():number{return run((acc,x)=>acc+x);}`,
      ),
    ).toBe(18);
  });

  it("index / array callback params are plumbed", async () => {
    expect(
      await runStandalone(
        `function run(cb:(x:number,i:number,arr:number[])=>boolean):boolean{const a=[1,2,3];return a.some(cb);}` +
          `export function test():number{return run((x,i,arr)=>arr.length===3&&i===2&&x===3)?1:0;}`,
      ),
    ).toBe(1);
  });

  it("byte-neutral: already-native inline arrow / named fn callbacks still work", async () => {
    expect(await runStandalone(`export function test():number{const a=[1,2,3];return a.some(x=>x>2)?1:0;}`)).toBe(1);
    expect(
      await runStandalone(
        `function isEven(x:number):boolean{return x%2===0;}` +
          `export function test():number{const a=[1,2,4];return a.some(isEven)?1:0;}`,
      ),
    ).toBe(1);
  });

  it("host (gc) mode still compiles the dynamic-param callback (bridge path untouched)", async () => {
    const r = await compile(
      `function run(cb:(x:number)=>boolean):boolean{const a=[1,2,3];return a.some(cb);}` +
        `export function test():number{return run(x=>x>2)?1:0;}`,
      { fileName: "test.ts", target: "gc" },
    );
    expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  });
});
