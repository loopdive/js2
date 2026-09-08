import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

async function run(source: string) {
  const result = await compileMulti({ "/probe/main.ts": source }, "/probe/main.ts", {
    target: "standalone",
    platform: "deno",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = await WebAssembly.compile(result.binary as BufferSource);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: any[]) => any>;
}

describe("Deno error constructor values", () => {
  it.each(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"])(
    "constructs %s through the staged registry",
    async (name) => {
      const e = await run(`
        let build:any;
        function stage() { (()=>{
          const errorMap={};
          function register(name:any, C:any):void { errorMap[name]=(msg:any)=>new C(msg); }
          register('${name}', ${name});
          build=(name:any,msg:any)=>errorMap[name]?.(msg);
        })(); }
        export function init():void { stage(); }
        export function make():any { return build('${name}', 'host failure'); }
        export function check(e:any):number {
          return e.name==='${name}' && e.message==='host failure' && e instanceof ${name} ? 1 : 0;
        }
      `);
      e.init();
      expect(e.check(e.make())).toBe(1);
    },
  );

  it.each([
    ["null", "null"],
    ["42", "42"],
    ["false", "false"],
  ])("coerces a dynamic message %s", async (value, expected) => {
    const e = await run(`
        export function ctor():any { return TypeError; }
        export function message():any { return ${value}; }
        export function make(C:any, msg:any):any { return new C(msg); }
        export function check(e:any):number { return e.name==='TypeError' && e.message===${JSON.stringify(expected)} ? 1 : 0; }
      `);
    expect(e.check(e.make(e.ctor(), e.message()))).toBe(1);
  });

  it("preserves ordinary constructors alongside intrinsic constructors", async () => {
    const e = await run(`
      function Ordinary(this:any, msg:any) { this.message=msg; }
      export function ctor():any { return Ordinary; }
      export function intrinsic():any { return TypeError; }
      export function make(C:any):any { return new C('ok'); }
      export function check(e:any):number { return e.message==='ok' ? 1 : 0; }
    `);
    expect(e.check(e.make(e.ctor()))).toBe(1);
    expect(e.check(e.make(e.intrinsic()))).toBe(1);
  });

  it("supports an absent message and rejects Symbol messages", async () => {
    const e = await run(`
      export function ctor():any { return TypeError; }
      export function empty(C:any):number { const e=new C(); return e.name==='TypeError' && !Object.prototype.hasOwnProperty.call(e, 'message') ? 1 : 0; }
      export function absent(C:any):number { const e=new C(undefined); return e.name==='TypeError' && !Object.prototype.hasOwnProperty.call(e,'message') ? 1 : 0; }
      export function symbol(C:any):number { try { new C(Symbol('x')); return 0; } catch(e) { return e instanceof TypeError ? 1 : 0; } }
    `);
    expect(e.empty(e.ctor())).toBe(1);
    expect(e.absent(e.ctor())).toBe(1);
    expect(e.symbol(e.ctor())).toBe(1);
  });
  it("coerces object messages once and preserves coercion exceptions", async () => {
    const e = await run(`
      export function ctor():any { return TypeError; }
      export function check(C:any):number {
        let count=0;
        const error=new C({toString(){count++;return 'message';}});
        return count===1 && error.message==='message' ? 1 : 0;
      }
      export function abrupt(C:any):number {
        const token={};
        try { new C({toString(){throw token;}}); return 0; }
        catch(error) { return error===token ? 1 : 0; }
      }
    `);
    expect(e.check(e.ctor())).toBe(1);
    expect(e.abrupt(e.ctor())).toBe(1);
  });
});
