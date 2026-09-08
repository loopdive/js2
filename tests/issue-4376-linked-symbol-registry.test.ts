import { beforeAll, describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

describe.each([false, true])("shared Symbol state (multi=%s)", (multi) => {
  type Exports = Record<string, (...args: any[]) => any>;
  let context: Exports;
  let a: Exports;
  let b: Exports;

  // Setup errors must fail the suite, never satisfy the expected identity failure.
  beforeAll(async () => {
    const options = {
      target: "standalone" as const,
      platform: "deno" as const,
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
    };
    async function instantiate(source: string, linked = false, imports: WebAssembly.Imports = {}) {
      const config = {
        ...options,
        fileName: "linked-symbols.ts",
        standaloneSymbolState: linked ? { module: "v8x:context" } : "export",
        ...(linked
          ? {
              standaloneGlobalThisImport: {
                module: "v8x:context",
                name: "__v8x_context_global_this",
                call: "__v8x_context_call",
              },
              link: ["v8x:context"],
            }
          : {}),
      } as Parameters<typeof compile>[1];
      const result = multi
        ? await compileMulti({ "/linked-symbols.ts": source }, "/linked-symbols.ts", config)
        : await compile(source, config);
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary as BufferSource, imports);
      const e = instance.exports as Record<string, (...args: any[]) => any>;
      e.__module_init?.();
      return e;
    }
    context = await instantiate(`
    export function __v8x_context_global_this():any {return globalThis;}
    export function __v8x_context_call(f:any,r:any,a:any):any{return f.apply(r,a);}
    export function same(a:any,b:any):number{return a===b?1:0;}
  `);
    const imports = { "v8x:context": context } as WebAssembly.Imports;
    a = await instantiate(
      `
    Symbol.for('unrelated-first-allocation');

function typed(value:symbol):any{return value;}
export function round(value:any):any{return typed(value);}
export function absent():any{return Symbol();}
export function empty():any{return Symbol('');}
export function iterator():any{return Symbol.iterator;}
export function descriptionIs(value:any,text:any):number{return value.description===text?1:0;}
export function absentDescription(value:any):number{return value.description===undefined?1:0;}
export function keyIs(value:any):number{return Symbol.keyFor(value)==='shared'?1:0;}
export function unregistered(value:any):number{return Symbol.keyFor(value)===undefined?1:0;}
export function text():any{return 'same';}
export function grow(n:number):void{for(let i=0;i<n;i++){Symbol.for('grow'+i);Symbol('fresh');}}
export function read(value:any,key:any):any{return value[key];}
export function write(value:any,key:any,n:number):void{value[key]=n;}
export function bag():any{return {};}
    export function registered():any {return Symbol.for('shared');}
    export function fresh():any {return Symbol('same');}
    export function publish():void {(globalThis as any).linkedSymbol=registered();}
  `,
      true,
      imports,
    );
    b = await instantiate(
      `

function typed(value:symbol):any{return value;}
export function round(value:any):any{return typed(value);}
export function absent():any{return Symbol();}
export function empty():any{return Symbol('');}
export function iterator():any{return Symbol.iterator;}
export function descriptionIs(value:any,text:any):number{return value.description===text?1:0;}
export function absentDescription(value:any):number{return value.description===undefined?1:0;}
export function keyIs(value:any):number{return Symbol.keyFor(value)==='shared'?1:0;}
export function unregistered(value:any):number{return Symbol.keyFor(value)===undefined?1:0;}
export function text():any{return 'same';}
export function grow(n:number):void{for(let i=0;i<n;i++){Symbol.for('grow'+i);Symbol('fresh');}}
export function read(value:any,key:any):any{return value[key];}
export function write(value:any,key:any,n:number):void{value[key]=n;}
export function bag():any{return {};}
    export function registered():any {return Symbol.for('shared');}
    export function fresh():any {return Symbol('same');}
    export function published():any {return (globalThis as any).linkedSymbol;}
  `,
      true,
      imports,
    );
    a.publish();
  });

  it("preserves published Symbol identity across linked graphs", () => {
    expect(context.same(a.registered(), b.published())).toBe(1);
  });

  it("does not merge fresh Symbol identities between linked graphs", () => {
    expect(context.same(a.fresh(), b.fresh())).toBe(0);
  });

  it("shares registered Symbol identity between linked graphs", () => {
    expect(context.same(a.registered(), b.registered())).toBe(1);
  });

  it("preserves typed-to-erased round trips and well-known identity", () => {
    expect(context.same(a.round(b.registered()), b.registered())).toBe(1);
    expect(context.same(a.iterator(), b.iterator())).toBe(1);
  });
  it("reads registry keys and fresh descriptions across graphs", () => {
    expect(b.keyIs(a.registered())).toBe(1);
    expect(b.unregistered(a.fresh())).toBe(1);
    expect(b.descriptionIs(a.fresh(), b.text())).toBe(1);
    expect(b.absentDescription(a.absent())).toBe(1);
    expect(b.absentDescription(a.empty())).toBe(0);
  });
  it("uses foreign registered and fresh Symbols as distinct property keys", () => {
    const bag = a.bag(),
      fresh = a.fresh(),
      other = b.fresh();
    a.write(bag, a.registered(), 71);
    expect(b.read(bag, b.registered())).toBe(71);
    b.write(bag, fresh, 17);
    b.write(bag, other, 29);
    expect(a.read(bag, fresh)).toBe(17);
    expect(a.read(bag, other)).toBe(29);
  });
  it("keeps existing identities while both modules grow shared tables", () => {
    const registered = a.registered(),
      fresh = b.fresh();
    a.grow(300);
    b.grow(400);
    expect(context.same(a.registered(), registered)).toBe(1);
    expect(context.same(b.round(fresh), fresh)).toBe(1);
    expect(a.descriptionIs(fresh, b.text())).toBe(1);
  });
});
