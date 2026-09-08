// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string) {
  const result = await compile(source, { target: "standalone", platform: "deno", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  expect((instance.exports.test as () => number)()).toBe(42);
}

describe("first-class Function.prototype.call", () => {
  it("preserves receiver and more arguments than its advertised length", async () => {
    await run(`function invoke(f:any):any { return f.call({base:21},1,2,3,4,5,6); }
      export function test():number { return invoke(function(this:any,a:any,b:any,c:any,d:any,e:any,f:any):any {return this.base+a+b+c+d+e+f;}); }`);
  });
  it("supports extracted call through Reflect.apply", async () => {
    await run(`export function test():number { const call:any=Function.prototype.call;
      return Reflect.apply(call,function(this:any,x:any):any{return this.base+x;},[{base:40},2]); }`);
  });
  it("keeps the exact receiver object", async () => {
    await run(`export function test():number {const receiver={x:42}; const target:any=function(this:any):any{return this;};
      return Reflect.apply(Function.prototype.call,target,[receiver])===receiver?42:0;}`);
  });
  it("forwards explicit undefined arguments without padding omitted ones", async () => {
    await run(`function invoke(f:any):any{return f.call(null,undefined,7);}
      export function test():number {return invoke(function(...args:any[]):number {return args.length===2 && args[0]===undefined && args[1]===7?42:0;});}`);
  });
  it("forwards an empty argument list", async () => {
    await run(`function invoke(f:any):any{return f.call();}
      export function test():number {return invoke(function(...args:any[]):number{return args.length===0?42:0;});}`);
  });
  it("rejects a noncallable receiver", async () => {
    await run(
      `export function test():number {try {Reflect.apply(Function.prototype.call,{},[]);}catch(e){return e instanceof TypeError?42:0;}return 0;}`,
    );
  });
  it("preserves literal arguments in direct Reflect.apply", async () => {
    await run(
      `export function test():number {return Reflect.apply(function(this:any,x:any):any{return this.base+x;},{base:40},[2]);}`,
    );
  });
  it("keeps omitted literal arguments omitted despite optional parameters", async () => {
    await run(
      `export function test():number {return Reflect.apply(function(x?:number):number{return arguments.length===0?42:0;},null,[]);}`,
    );
  });
  it("preserves thrown value identity", async () => {
    await run(`export function test():number {const marker={x:42};const target:any=function():void{throw marker;};
      try {Reflect.apply(Function.prototype.call,target,[]);}catch(e){return e===marker?42:0;}return 0;}`);
  });
});
