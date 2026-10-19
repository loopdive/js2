// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const SOURCE = `
export function rest():any{return function(...v:number[]):number{return v.length*1000+(v.length?v[v.length-1]:0);};}
export function prefix():any{return function(a:number,b:number,...v:number[]):number{return a+b+v.length*1000+(v.length?v[v.length-1]:0);};}
export function nine():any{return function(a:number,b:number,c:number,d:number,e:number,f:number,g:number,h:number,i:number):number{return arguments.length*1000+(arguments.length>31?arguments[31]:0);};}
export function fourteen():any{return function(a:number,b:number,c:number,d:number,e:number,f:number,g:number,h:number,i:number,j:number,k:number,l:number,m:number,n:number):number{return arguments.length*1000+(arguments.length>31?arguments[31]:0);};}
export function invoke(f:any,receiver:any,args:any):any{return f.apply(receiver,args);}
export function run(kind:number,count:number):number{
 const args:number[]=[];for(let i=0;i<count;i++)args.push(i+0.5);
 const f:any=kind===0?rest():kind===1?prefix():kind===2?nine():fourteen();
 return f.apply(null,args);
}
`;

async function instantiate(source: string, target: "standalone" | "wasi" | "gc") {
  const result = await compile(source, { target, skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  if (target === "gc") {
    const imports = buildCompiledImports(result);
    const instance = new WebAssembly.Instance(module, imports);
    imports.setInstance?.(instance);
    return wrapCompiledExports(result, instance) as Record<string, (...args: any[]) => any>;
  }
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return new WebAssembly.Instance(module, {}).exports as Record<string, (...args: any[]) => any>;
}

for (const target of ["standalone", "wasi", "gc"] as const) {
  describe(`native apply argument tails (${target})`, () => {
    let ex: Record<string, (...args: any[]) => any>;
    beforeAll(async () => {
      ex = await instantiate(SOURCE, target);
    });
    for (const count of [0, 1, 4, 5, 6, 8, 9, 14, 32]) {
      it(`retains all ${count} numeric rest elements`, () => {
        expect(ex.run!(0, count)).toBe(count * 1000 + (count ? count - 0.5 : 0));
      });
      for (const [kind, name] of [
        [2, "nine"],
        [3, "fourteen"],
      ] as const) {
        it(`retains actual argc and far extras for ${name}, ${count} inputs`, () => {
          expect(ex.run!(kind, count)).toBe(count * 1000 + (count > 31 ? 31.5 : 0));
        });
      }
    }
    for (const count of [2, 5, 6, 9, 14, 32]) {
      it(`retains a numeric rest tail after a prefix, ${count} inputs`, () => {
        expect(ex.run!(1, count)).toBe(2 + (count - 2) * 1000 + (count > 2 ? count - 0.5 : 0));
      });
    }
    it("crosses missing dispatcher widths in an isolated typed-rest-only module", async () => {
      const isolated = await instantiate(
        `
        export function rest():any{return function(...v:number[]):number{return v.length;};}
        export function run(n:number):number{const a:number[]=[];for(let i=0;i<n;i++)a.push(i);const f:any=rest();return f.apply(null,a);}
      `,
        target,
      );
      for (const count of [0, 5, 6, 8, 9, 32]) expect(isolated.run!(count)).toBe(count);
    });
    if (target === "gc") {
      it("calls a returned typed rest function with all 32 values", () => {
        expect(ex.rest!()(...Array(32).fill(1.5))).toBe(32001.5);
      });
      it("calls a returned wide function with far extras instead of refusing", () => {
        expect(ex.nine!()(...Array(32).fill(1.5))).toBe(32001.5);
      });
      for (const count of [9, 32])
        it(`seeds argc after reentrant getters, reads exactly ${count} entries`, () => {
          const events: number[] = [];
          const args = new Proxy(
            { length: count },
            {
              get(t, k) {
                if (k === "length") return t.length;
                if (typeof k === "string" && /^\d+$/.test(k)) {
                  const i = Number(k);
                  events.push(i);
                  expect(ex.rest!()(1.5)).toBe(1001.5);
                  return i + 0.5;
                }
                return Reflect.get(t, k);
              },
            },
          );
          expect(ex.invoke!(ex.nine!(), null, args)).toBe(count * 1000 + (count > 31 ? 31.5 : 0));
          expect(events).toEqual(Array.from({ length: count }, (_, i) => i));
        });
      it("does not leak a partial tail after a getter throws", () => {
        const token = {};
        const args = new Proxy(
          { length: 32 },
          {
            get(t, k) {
              if (k === "20") throw token;
              return k === "length" ? t.length : 1.5;
            },
          },
        );
        try {
          ex.invoke!(ex.nine!(), null, args);
          expect.unreachable("must throw");
        } catch (error) {
          expect(error).toBe(token);
        }
        expect(ex.nine!()(...Array(32).fill(1.5))).toBe(32001.5);
      });
    }
  });
}
