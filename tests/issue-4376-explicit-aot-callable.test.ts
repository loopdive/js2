import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { execFileSync } from "node:child_process";

describe("explicit host-callable exposure across modules", () => {
  it.each([0, 1, 3, 8])("preserves arguments and host function length %i across modules", async (arity) => {
    const caller = await compile(
      `
      function __runtime_eval_wrap_aot_callable(value:any):any { return value; }
      export function demand(source:any):any { return (0,eval)(source); }
      export function make():any {
        return __runtime_eval_wrap_aot_callable(function(...args:any[]):number {
          return args.length * 100 + (Array.isArray(args[0]) ? args[0].length : 0);
        });
      }
      export function decorate(fn:any):number { Object.defineProperty(fn,"length",{value:${arity},configurable:true}); return fn.length; }
      export function array():any { return [1,2,3] as any[]; }
      export function scalar():any { return 42; }
      export function key():any { return "length"; }
    `,
      { target: "standalone", fileName: "caller.ts", skipSemanticDiagnostics: true },
    );
    const provider = await compile(
      `
      function __runtime_eval_apply_callable(fn:any, receiver:any, args:any[]):any { return fn.apply(receiver,args); }
      export function demand(source:any):any { return (0,eval)(source); }
      export function invoke(fn:any,value:any):any { return __runtime_eval_apply_callable(fn,undefined,[value]); }
      export function three(fn:any,value:any):any { return __runtime_eval_apply_callable(fn,undefined,[value,value,value]); }
      export function empty(fn:any):any { return __runtime_eval_apply_callable(fn,undefined,[]); }
      export function arity(fn:any):number { return fn.length; }
      export function computed(fn:any, key:any):number { return fn[key]; }
      export function numeric(value:any):number { return value; }
    `,
      { target: "standalone", fileName: "provider.ts", skipSemanticDiagnostics: true },
    );
    for (const result of [caller, provider]) expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const result = execFileSync(
      process.execPath,
      [
        "--experimental-wasm-exnref",
        "-e",
        `
      const data=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
      function instantiate(binary) {
        const module=new WebAssembly.Module(Buffer.from(binary,'base64'));
        const imports={}; for(const {module:ns,name} of WebAssembly.Module.imports(module))
          (imports[ns]??={})[name]=()=>{throw Error('unexpected provider entry '+name);};
        return new WebAssembly.Instance(module,imports).exports;
      }
      const caller=instantiate(data[0]),provider=instantiate(data[1]);
      caller.__module_init?.(); provider.__module_init?.();
      const fn=caller.make();
      console.log(JSON.stringify([
        provider.numeric(provider.invoke(fn,caller.array())),
        provider.numeric(provider.invoke(fn,caller.scalar())),
        provider.numeric(provider.three(fn,caller.scalar())),
        provider.numeric(provider.empty(fn)),
        caller.decorate(fn), provider.arity(fn), provider.computed(fn,caller.key()),
      ]));
    `,
      ],
      {
        input: JSON.stringify([
          Buffer.from(caller.binary).toString("base64"),
          Buffer.from(provider.binary).toString("base64"),
        ]),
        encoding: "utf8",
      },
    );
    expect(JSON.parse(result)).toEqual([103, 100, 300, 0, arity, arity, arity]);
  });
});
