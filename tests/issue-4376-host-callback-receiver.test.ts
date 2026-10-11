import { expect, it } from "vitest";
import { compile } from "../src/index.js";

for (const method of ["call", "apply"]) {
  it(`preserves the receiver of an escaped rest callback through ${method}`, async () => {
    const result = await compile(
      `
      const functions:any[] = [];
      functions.push(Math.max, Math.min, String.fromCharCode);
      const ids = new Map<any,number>();
      ids.set(globalThis,1);
      function keep(value:any):number {
        const prior=ids.get(value);
        if(prior!==undefined) return prior;
        ids.set(value,42);
        return 42;
      }
      function __runtime_eval_wrap_aot_callable(value:any):any { return value; }
      const prototype:any = Function.prototype;
      functions.push(prototype.call);
      function make(id:number):any {
        const fn:any = __runtime_eval_wrap_aot_callable(function(this:any, ...args:any[]):any {
          if (new.target) throw new TypeError("not a constructor");
          return keep(this) === keep(args[0]) ? id : -1;
        });
        functions.push(fn);
        return fn;
      }
      function invoke(host:any, object:any):number {
        return ${method === "call" ? "host.call(object,object,[1,2,3],function(value:any){return value})" : "host.apply(object,[object,[1,2,3],function(value:any){return value}])"};
      }
      export function run():number {
        const host:any = make(42);
        const object:any = {value:40};
        const values:any[] = [invoke,host,object];
        return values[0].apply(globalThis,[values[1],values[2]]);
      }
    `,
      { target: "standalone", platform: "deno", hostBridge: "always", deferTopLevelInit: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = result.importObject ?? {};
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.run as () => number)()).toBe(42);
  });
}
