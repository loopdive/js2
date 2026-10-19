// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { WASI } from "node:wasi";
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const source = `
 const assign=Object.assign;
 export function many(n:number):number {
   const t:any={}; const token={value:n};
   const r=assign(t,{a:n,token},null,{b:n+1},undefined,{a:n+2});
   return r===t && t.a===n+2 && t.b===n+1 && t.token===token ? 42:-1;
 }
 export function called(n:number):number {
   const f:any=assign;const t:any={};const r=f.call(null,t,{a:n},{b:n+1});
   return r===t && t.a===n && t.b===n+1?42:-1;
 }
 export function applied(n:number):number {
   const f:any=assign;const t:any={};const r=f.apply(null,[t,{a:n},{b:n+1}]);
   return r===t && t.a===n && t.b===n+1?42:-1;
 }
 export function aliasChain(n:number):number {
   const second=assign;const third=second;const t:any={};const r=third(t,{a:n},{b:n+1});
   return r===t && t.a===n && t.b===n+1?42:-1;
 }
 export function destructured(n:number):number {
   const {assign:fn}=Object;const t:any={};const r=fn(t,{a:n},{b:n+1});
   return r===t && t.a===n && t.b===n+1?42:-1;
 }
 export function empty(n:number):number {
   const t:any={value:n}; return assign(t)===t && t.value===n?42:-1;
 }
 export function missing(n:number):number {
   try { assign(); } catch(e) { return e instanceof TypeError?42:-1; } return -2;
 }
 export function nullTarget(n:number):number {
   let gets=0;const input={get value(){gets++;return n;}};
   try { assign(null,input); } catch(e) { return e instanceof TypeError && gets===0?42:-1; } return -2;
 }
 export function order(n:number):number {
   let events="";const t:any={};
   const a={get value(){events+="a";return n;}};
   const b={get value(){events+="b";return n+1;}};
   return assign(t,a,b)===t && t.value===n+1 && events==="ab"?42:-1;
 }
 export function abrupt(n:number):number {
   const token={value:n};const t:any={};let gets=0;
   const later={get c(){gets++;return n;}};
   try { assign(t,{a:n},{get b(){throw token;}},later); } catch(e) {
     return e===token && t.a===n && !Object.hasOwn(t,"b") && gets===0?42:-1;
   }
   return -2;
 }
 export function rejected(n:number):number {
   const t=new Proxy({}, {set(target,key,value){return false;}});
   const input=new Proxy({a:n},{});
   try { assign(t,input); } catch(e) {return e instanceof TypeError?42:-1;} return -2;
 }
 export function siblingAbi(n:number):number {
   function rest(this:any,...args:any[]):number {return this.value+args.length;}
   return Math.max.apply(null,[n,n+1,n-1])===n+1 &&
     String.fromCharCode.call(null,65,66)==="AB" &&
     rest.apply({value:n},[1,2,3])===n+3?42:-1;
 }
 export function accepted(n:number):number {
   let hits=0;const t=new Proxy({}, {set(target,key,value){hits++;return true;}});
   return assign(t,new Proxy({a:n},{}))===t && hits===1?42:-1;
 }
 export function forwarded(n:number):number {
   const raw:any={};const t=new Proxy(raw,{});
   return assign(t,new Proxy({a:n},{}))===t && raw.a===n?42:-1;
 }
 export function setThrows(n:number):number {
   const token={value:n};let hits=0;const t=new Proxy({}, {set(target,key,value){hits++;throw token;}});
   try {assign(t,new Proxy({a:n},{}));}catch(e){return e===token && hits===1?42:-1;}return -2;
 }
 export function metadata(n:number):number {
   return assign.length===2 && assign.name==="assign" && assign===Object.assign?42:-1;
 }
 export function shadowed(n:number):number {
   const Object={assign(a:any,b:any,c:any){return n+b+c;}};
   const fn=Object.assign;return fn({},2,3)===n+5?42:-1;
 }
 export function copy(target:any,input:any,other:any):any {return assign(target,input,other);}
 export function copyCall(target:any,input:any):any {return assign.call(null,target,input);}
 export function copyApply(target:any,input:any):any {return assign.apply(null,[target,input]);}
 export function directCopy(target:any,input:any):any {return Object.assign(target,input);}
`;
type Exports = Record<string, (...args: any[]) => any>;
const nativeNames = [
  "many",
  "called",
  "applied",
  "aliasChain",
  "destructured",
  "empty",
  "missing",
  "nullTarget",
  "order",
  "abrupt",
  "rejected",
  "siblingAbi",
  "accepted",
  "forwarded",
  "setThrows",
  "metadata",
  "shadowed",
];

for (const target of ["standalone", "wasi", "gc"] as const) {
  describe(`#6979 captured Object.assign native argv contract — ${target}`, () => {
    let ex: Exports;
    beforeAll(async () => {
      const result = await compile(source, {
        target,
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
        trackIrOutcomes: true,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      if (target === "gc") {
        const imports = buildCompiledImports(result);
        const instance = await WebAssembly.instantiate(module, imports);
        imports.setInstance?.(instance);
        ex = wrapCompiledExports(result, instance) as Exports;
      } else {
        const imports = WebAssembly.Module.imports(module);
        expect(imports.every((row) => row.module === "wasi_snapshot_preview1")).toBe(true);
        if (target === "standalone") expect(imports).toEqual([]);
        const wasi = target === "wasi" ? new WASI({ version: "preview1", returnOnExit: true }) : undefined;
        ex = (await WebAssembly.instantiate(module, wasi?.getImportObject() ?? {})).exports as Exports;
      }
      ex.__module_init?.();
    });
    for (const name of nativeNames)
      it(name, () => {
        expect(ex[name]!(7)).toBe(42);
        expect(ex[name]!(13)).toBe(42);
      });
  });
}

describe("#6979 native Object.assign over identity-backed JS boundary values", () => {
  let ex: Exports;
  beforeAll(async () => {
    const result = await compile(source, { skipSemanticDiagnostics: true, deferTopLevelInit: true });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    ex = wrapCompiledExports(result, instance) as Exports;
    ex.__module_init?.();
  });
  for (const method of ["copy", "copyCall", "copyApply", "directCopy"])
    it(method + ": retains original target, nested value and exact symbols", () => {
      const token = {},
        key = Symbol("key"),
        target: any = {};
      const input = Object.create({ inherited: 1 });
      Object.defineProperty(input, "hidden", { value: 5, enumerable: false });
      input.value = token;
      input[key] = token;
      expect(ex[method]!(target, input)).toBe(target);
      expect(target.value).toBe(token);
      expect(target[key]).toBe(token);
      expect(Reflect.ownKeys(target)).toEqual(["value", key]);
    });
  it("observes one ownKeys and each live descriptor before Get, without prototype probes", () => {
    const token = {},
      key = Symbol("key"),
      events: unknown[] = [],
      target: any = {};
    const input = new Proxy(
      {},
      {
        ownKeys() {
          events.push("keys");
          return ["hidden", "gone", "value", key];
        },
        getOwnPropertyDescriptor(_target, k) {
          events.push(["desc", k]);
          return k === "gone" ? undefined : { enumerable: k !== "hidden", configurable: true };
        },
        get(_target, k) {
          events.push(["get", k]);
          return token;
        },
        getPrototypeOf() {
          throw Error("unexpected prototype probe");
        },
      },
    );
    expect(ex.copy!(target, input)).toBe(target);
    expect(events).toEqual([
      "keys",
      ["desc", "hidden"],
      ["desc", "gone"],
      ["desc", "value"],
      ["get", "value"],
      ["desc", key],
      ["get", key],
    ]);
    expect(target.value).toBe(token);
    expect(target[key]).toBe(token);
  });
  it("propagates the original getter token and retains only earlier writes", () => {
    const token = {},
      target: any = {};
    const input = {
      a: 7,
      get b() {
        throw token;
      },
    };
    let caught: unknown;
    try {
      ex.copy!(target, input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(token);
    expect(target.a).toBe(7);
    expect(Object.hasOwn(target, "b")).toBe(false);
  });
  it("throws on a rejected JS target write", () => {
    const target = Object.defineProperty({}, "value", { value: 0, writable: false });
    expect(() => ex.copy!(target, { value: 7 })).toThrow(TypeError);
  });
  it("propagates an original JS set-trap token", () => {
    const token = {};
    const target = new Proxy(
      {},
      {
        set() {
          throw token;
        },
      },
    );
    let caught: unknown;
    try {
      ex.copy!(target, { value: 7 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(token);
  });
  it("checks each descriptor live after an earlier getter changes a later key", () => {
    const target: any = {};
    const input = {
      get a() {
        Object.defineProperty(input, "b", { enumerable: false });
        return 7;
      },
      b: 13,
    };
    expect(ex.copy!(target, input)).toBe(target);
    expect(target).toEqual({ a: 7 });
  });
});

for (const target of ["standalone", "wasi", "gc"] as const) {
  const cases = {
    patchedObject: `export function run(n:number):number {
      Object.assign=function(t:any,...sources:any[]):any { t.answer=n+sources.length; return t; };
      const fn=Object.assign; const t:any={}; const r:any=fn(t,{a:n},{b:n});
      return r===t && t.answer===n+2?42:-1;
    }`,
    reboundAlias: `export function run(n:number):number {
      let fn=Object.assign;
      fn=function(t:any,...sources:any[]):any {t.answer=n+sources.length;return t;};
      const t:any={};const r:any=fn(t,{a:n},{b:n});return r===t && t.answer===n+2?42:-1;
    }`,
    capturedBeforePatch: `const original=Object.assign; export function run(n:number):number {
      Object.assign=original;
      const before=Object.assign;
      Object.assign=function(t:any,...sources:any[]):any {t.answer=n+sources.length;return t;};
      const t:any={}; const r:any=before(t,{a:n},{b:n+1});
      const after=Object.assign;const u:any={};const s:any=after(u,{a:n},{b:n});
      return r===t && t.a===n && t.b===n+1 && s===u && u.answer===n+2?42:-1;
    }`,
  };
  for (const [name, program] of Object.entries(cases)) {
    it(`#6979 builtin identity guard — ${target} / ${name}`, async () => {
      const result = await compile(program, { target, skipSemanticDiagnostics: true, deferTopLevelInit: true });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      let ex: Exports;
      if (target === "gc") {
        const imports = buildCompiledImports(result);
        const instance = await WebAssembly.instantiate(module, imports);
        imports.setInstance?.(instance);
        ex = wrapCompiledExports(result, instance) as Exports;
      } else {
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        ex = (await WebAssembly.instantiate(module, {})).exports as Exports;
      }
      ex.__module_init?.();
      expect(ex.run!(7)).toBe(42);
      expect(ex.run!(13)).toBe(42);
    });
  }
}
