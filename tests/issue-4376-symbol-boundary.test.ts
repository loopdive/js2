import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

describe("native Symbol values through erased boundaries", () => {
  it.each([false, true])("retains Symbol branding and descriptions (multi=%s)", async (multi) => {
    const source = `
      export function registered():any { return Symbol.for('registry-key'); }
      export function fresh():any { return Symbol('fresh'); }
      export function absent():any { return Symbol(); }
      export function empty():any { return Symbol(''); }
      export function symbol(value:any):number { return typeof value === 'symbol' ? 1 : 0; }
      export function description(value:any, text:any):number { return value.description === text ? 1 : 0; }
      export function text(which:number):any { return which===0?'registry-key':which===1?'fresh':''; }
      export function isAbsent(value:any):number { return value.description === undefined ? 1 : 0; }
      export function registry(value:any):number { return Symbol.keyFor(value)==='registry-key'?1:0; }
      export function reject(value:any):number { try { Symbol.keyFor(value); return 0; } catch(error) { return error instanceof TypeError ? 1 : -1; } }
      export function ordinary():number { const value:any={description:'ordinary'};return value.description==='ordinary'?1:0; }
    `;
    const options = {
      target: "standalone" as const,
      platform: "deno" as const,
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
    };
    const result = multi
      ? await compileMulti({ "/symbol.ts": source }, "/symbol.ts", options)
      : await compile(source, { ...options, fileName: "symbol.ts" });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary as BufferSource, {});
    const e = instance.exports as Record<string, (...args: any[]) => any>;
    e.__module_init?.();
    const registered = e.registered();
    expect(e.symbol(registered)).toBe(1);
    expect(registered).toBe(e.registered());
    expect(e.registry(registered)).toBe(1);
    expect(e.description(registered, e.text(0))).toBe(1);
    const first = e.fresh();
    expect(first === e.fresh()).toBe(false);
    expect(e.symbol(first)).toBe(1);
    expect(e.description(first, e.text(1))).toBe(1);
    expect(e.isAbsent(e.absent())).toBe(1);
    expect(e.isAbsent(e.empty())).toBe(0);
    expect(e.description(e.empty(), e.text(2))).toBe(1);
    expect(e.ordinary()).toBe(1);
    expect(e.reject(null)).toBe(1);
    expect(e.reject(e.text(0))).toBe(1);
  });
});
