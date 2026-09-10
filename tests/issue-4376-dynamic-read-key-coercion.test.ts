import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.ts";

for (const multi of [false, true]) {
  it(`normalizes dynamic read keys once and preserves Symbol keys (multi=${multi})`, async () => {
    const source = `
      let conversions=0;
      export function array():any {const a:any[]=[true,false];return a;}
      export function read(receiver:any,key:any):number {return receiver[key]===true?1:0;}
      export function key():any {return {toString(){conversions++;return '0';}};}
      export function count():number{return conversions;}
      export function text():any{return '0';}
      export function symbol():any{return Symbol.for('property-key');}
      export function bag():any {const o:any={};o[Symbol.for('property-key')]=true;return o;}
    `;
    const options = { target: "standalone" as const, hostBridge: "always" as const };
    const result = multi
      ? await compileMulti({ "/keys.ts": source }, "/keys.ts", options)
      : await compile(source, options);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const e = (await WebAssembly.instantiate(result.binary as BufferSource)).instance.exports as Record<
      string,
      (...args: any[]) => any
    >;
    e.__module_init?.();
    const array = e.array();
    // Raw JS numbers are not the standalone boxed-any ABI. Produce numeric
    // keys via the native string key and object coercion paths here.
    expect(e.read(array, e.text())).toBe(1);
    const key = e.key();
    expect(e.read(array, key)).toBe(1);
    expect(e.count()).toBe(1);
    expect(() => e.read(null, key)).toThrow();
    expect(e.count()).toBe(1);
    expect(e.read(e.bag(), e.symbol())).toBe(1);
  });
}
