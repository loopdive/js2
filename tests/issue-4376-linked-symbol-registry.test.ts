import { expect, it } from "vitest";
import { compile } from "../src/index.js";

// Known integration gap: independent graphs still own separate Symbol registries.
it.fails("shares registered Symbols without merging fresh identities between linked graphs", async () => {
  const options = {
    target: "standalone" as const,
    platform: "deno" as const,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  };
  async function instantiate(source: string, linked = false, imports: WebAssembly.Imports = {}) {
    const result = await compile(source, {
      ...options,
      fileName: "linked-symbols.ts",
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
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary as BufferSource, imports);
    const e = instance.exports as Record<string, (...args: any[]) => any>;
    e.__module_init?.();
    return e;
  }
  const context = await instantiate(`
    export function __v8x_context_global_this():any {return globalThis;}
    export function __v8x_context_call(f:any,r:any,a:any):any{return f.apply(r,a);}
    export function same(a:any,b:any):number{return a===b?1:0;}
  `);
  const imports = { "v8x:context": context } as WebAssembly.Imports;
  const a = await instantiate(
    `
    Symbol.for('unrelated-first-allocation');
    export function registered():any {return Symbol.for('shared');}
    export function fresh():any {return Symbol('same');}
    export function publish():void {(globalThis as any).linkedSymbol=registered();}
  `,
    true,
    imports,
  );
  const b = await instantiate(
    `
    export function registered():any {return Symbol.for('shared');}
    export function fresh():any {return Symbol('same');}
    export function published():any {return (globalThis as any).linkedSymbol;}
  `,
    true,
    imports,
  );
  a.publish();
  expect(context.same(a.registered(), b.published())).toBe(1);
  expect(context.same(a.fresh(), b.fresh())).toBe(0);
  expect(context.same(a.registered(), b.registered())).toBe(1);
});
