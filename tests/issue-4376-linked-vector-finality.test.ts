import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.ts";

for (const multi of [false, true]) {
  it(`shares reference vectors with a module that registers subtypes (multi=${multi})`, async () => {
    async function build(source: string) {
      const options = { target: "standalone" as const, hostBridge: "always" as const };
      const result = multi
        ? await compileMulti({ "/vector.ts": source }, "/vector.ts", options)
        : await compile(source, options);
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const e = (await WebAssembly.instantiate(result.binary as BufferSource)).instance.exports as Record<
        string,
        (...args: any[]) => any
      >;
      e.__module_init?.();
      return e;
    }
    const producer = await build(`
      export function value():any {const result:any[]=['marker',42];return result;}
      export function argumentsSubtype():any {return arguments;}
      export function ownRead(v:any):number {return v[1];}
      export function ownFirst(v:any):number {return v[0].charCodeAt(0);}
    `);
    const consumer = await build(`
      export function isArray(v:any):number {return Array.isArray(v)?1:0;}
      export function length(v:any):number {return v.length;}
      export function read(v:any):number {return v[1];}
      export function first(v:any):number {return v[0].charCodeAt(0);}
    `);
    const value = producer.value();
    expect(producer.ownRead(value)).toBe(42);
    expect(producer.ownFirst(value)).toBe(109);
    expect(consumer.length(value)).toBe(2);
    expect(consumer.isArray(value)).toBe(1);
    expect(consumer.read(value)).toBe(42);
    expect(consumer.first(value)).toBe(109);
  });
}

for (const multi of [false, true]) {
  it("preserves Boolean elements in a locally read any array (multi=" + multi + ")", async () => {
    const source =
      "export function value():any {const a:any[]=[true,42];return a;} export function first(v:any):number {return v[0]===true?1:0;}";
    const options = { target: "standalone" as const, hostBridge: "always" as const };
    const result = multi
      ? await compileMulti({ "/boolean.ts": source }, "/boolean.ts", options)
      : await compile(source, options);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const e = (await WebAssembly.instantiate(result.binary as BufferSource)).instance.exports as Record<
      string,
      (...args: any[]) => any
    >;
    e.__module_init?.();
    expect(e.first(e.value())).toBe(1);
  });
}
