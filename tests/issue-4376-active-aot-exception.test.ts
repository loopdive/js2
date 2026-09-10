import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("active eval AOT exception transport", () => {
  it.each(["17", '"payload"', "{}"])("catches caller payload %s during active reentry", async (payload) => {
    const options = { target: "standalone" as const, fileName: "boundary.ts", skipSemanticDiagnostics: true };
    const caller = await compile(
      `
      const thrown:any = ${payload};
      export function payload():any {return thrown;}
      function __runtime_eval_wrap_aot_callable(value:any):any {return value;}
      export function make(fail:boolean):any {
        return __runtime_eval_wrap_aot_callable(function():any {if(fail) throw thrown; return 29;});
      }
      export function run(source:any):any {return (0,eval)(source);}
      export function text():any {return "probe";}
    `,
      options,
    );
    const provider = await compile(
      `
      function __runtime_eval_apply_callable(fn:any,receiver:any,args:any[]):any {return fn.apply(receiver,args);}
      export function demand(source:any):any {return (0,eval)(source);}
      export function invoke(fn:any,expected:any):number {
        try {return __runtime_eval_apply_callable(fn,undefined,[]);}
        catch(e) {return e === expected ? 1017 : -1;}
      }
    `,
      options,
    );
    for (const result of [caller, provider]) expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instantiate = (binary: Uint8Array, entry: () => never) => {
      const module = new WebAssembly.Module(binary as BufferSource);
      const imports: WebAssembly.Imports = {};
      for (const { module: namespace, name } of WebAssembly.Module.imports(module)) {
        (imports[namespace] ??= {})[name] = entry;
      }
      const instance = new WebAssembly.Instance(module, imports);
      (instance.exports.__module_init as (() => void) | undefined)?.();
      return instance.exports;
    };
    const p = instantiate(provider.binary, () => {
      throw Error("unexpected nested provider import");
    });
    const stop = new Error("stop after the measured cross-module callback");
    let fn: unknown;
    let expected: unknown;
    const observed: number[] = [];
    for (const fail of [false, true]) {
      const c = instantiate(caller.binary, () => {
        observed.push((p.invoke as (fn: unknown, expected: unknown) => number)(fn, expected));
        // This test measures provider catch semantics, not the outer eval result
        // protocol. Stop explicitly before returning an invalid result to it.
        throw stop;
      });
      expected = (c.payload as () => unknown)();
      fn = (c.make as (fail: number) => unknown)(fail ? 1 : 0);
      expect((p.invoke as (fn: unknown, expected: unknown) => number)(fn, expected)).toBe(fail ? 1017 : 29);
      let escaped: unknown;
      try {
        (c.run as (source: unknown) => unknown)((c.text as () => unknown)());
      } catch (error) {
        escaped = error;
      }
      expect(escaped).toBe(stop);
    }
    expect(observed).toEqual([29, 1017]);
  });
});
