// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

for (const dynamicFirst of [false, true]) {
  it(`composes observable literal and driven iterable, dynamicFirst=${dynamicFirst}`, async () => {
    const literal = "Promise.all([1, 2]).then(function(v:any):void { a=v[0]*10+v[1]; });";
    const dynamic = "Promise.all(iterable).then(function(v:any):void { b=v[0]*10+v[1]; });";
    const source = `
declare function __drain_microtasks(): void;
export function test(): number {
  let a=-1; let b=-1;
  (Promise as any).resolve=function(value:any):any {
    return {then:function(ok:any):void {ok(value);}};
  };
  const iterable:any={};
  iterable[Symbol.iterator]=function():any {
    let i=0;
    return {next:function():any {i++;return {done:i>2,value:i*10};}};
  };
  ${dynamicFirst ? dynamic + literal : literal + dynamic}
  __drain_microtasks();
  return a*1000+b;
}`;
    const result = await compile(source, {
      fileName: "observable-drive.ts",
      target: "standalone",
      nativeStrings: true,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(12120);
  }, 30000);
}
