import { expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", platform: "deno", hostBridge: "off" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {});
  return (instance.exports.run as () => number)();
}

it("rejects construction in a dynamic rest callback without entering the host", async () => {
  expect(
    await run(`
    let entered=0;
    function make():any { return function(...args:any[]):any {
      if(new.target) throw new TypeError("cannot construct host callback");
      entered++; return 7;
    }; }
    function exercise(host:any):number {
      let rejected=false;
      try { new host(); } catch(error) {
        rejected=error instanceof TypeError && error.message==="cannot construct host callback";
      }
      return rejected && entered===0 && host()===7 && entered===1 ? 1 : -1;
    }
    export function run():number { return exercise(make()); }
  `),
  ).toBe(1);
});

it("returns the actual dynamic constructor as new.target", async () => {
  expect(
    await run(`
    function make():any { return function():any { return new.target; }; }
    function construct(C:any):any { return new C(); }
    export function run():number {
      const C:any=make(); return construct(C)===C && C()===undefined ? 1 : -1;
    }
  `),
  ).toBe(1);
});

it("keeps lexical new.target in an escaping arrow but clears it in ordinary nested calls", async () => {
  expect(
    await run(`
    function make():any { return function():any {
      const ordinary:any=function():any { return new.target; };
      if(ordinary()!==undefined) throw new Error("leaked target");
      return ()=>new.target;
    }; }
    function construct(C:any):any { return new C(); }
    export function run():number { const C:any=make(); const arrow:any=construct(C); return arrow()===C ? 1 : -1; }
  `),
  ).toBe(1);
});

it("does not retain construction state after a thrown callback", async () => {
  expect(
    await run(`
    const marker:any={value:17};
    function make():any { return function():any { if(new.target) throw marker; return new.target; }; }
    function exercise(C:any):number {
      let caught=false; try { new C(); } catch(error) { caught=error===marker; }
      return caught && C()===undefined ? 1 : -1;
    }
    export function run():number { return exercise(make()); }
  `),
  ).toBe(1);
});

it("binds construction state before parameter defaults", async () => {
  expect(
    await run(`
    function make():any { return function(target:any=new.target):any { return target; }; }
    function construct(C:any):any { return new C(); }
    export function run():number { const C:any=make(); return construct(C)===C ? 1 : -1; }
  `),
  ).toBe(1);
});

it("preserves new.target through a runtime-sized constructor argument vector", async () => {
  expect(
    await run(`
    function make():any { return function(...args:any[]):any { return {target:new.target,count:args.length,last:args[8]}; }; }
    function construct(C:any,args:any):any { return new C(...args); }
    export function run():number {
      const C:any=make(); const value:any=construct(C,[1,2,3,4,5,6,7,8,9]);
      return value.target===C && value.count===9 && value.last===9 ? 1 : -1;
    }
  `),
  ).toBe(1);
});

it.each([false, true])(
  "keeps non-rest array formals out of the full-vector rest shortcut (reversed=%s)",
  async (reversed) => {
    const rest = "function(...args:any[]):any { return args.length; }";
    const array = "function(args:any[]=[]):any { return args[0]; }";
    expect(
      await run(`
    const callbacks:any[]=[${reversed ? `${array},${rest}` : `${rest},${array}`}];
    function call(fn:any,args:any):any { return fn.apply(null,args); }
    export function run():number {
      return (call(callbacks[${reversed ? 1 : 0}],[1,2,3,4,5,6,7,8,9])===9 ? 1 : 0) +
        (call(callbacks[${reversed ? 0 : 1}],[[42]])===42 ? 2 : 0);
    }
  `),
    ).toBe(3);
  },
);

it("preserves receivers and thrown identity in full-vector rest calls", async () => {
  expect(
    await run(`
    const marker:any={value:17};
    const callbacks:any[]=[function(this:any,...args:any[]):any {
      if(args[8]===0) throw marker;
      return this.value+args.length+args[8];
    }];
    function call(fn:any,receiver:any,args:any):any { return fn.apply(receiver,args); }
    export function run():number {
      let caught=false;
      try { call(callbacks[0],{value:99},[1,2,3,4,5,6,7,8,0]); }
      catch(error) { caught=error===marker; }
      return caught && call(callbacks[0],{value:24},[1,2,3,4,5,6,7,8,9])===42 ? 1 : -1;
    }
  `),
  ).toBe(1);
});
