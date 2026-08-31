import { describe, it, expect } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2931 — a function declaration whose name is reassigned (`fn = 2`) is a live
// binding: later reads must observe the new value. Backed by a mutable externref
// module global that both the write and every read go through. Uses `.ts`
// fixtures for the cross-module case so it is isolated from #2932 (compiling
// `.js` module dependencies).
async function runSingle(src: string): Promise<number> {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  const importObj = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
  if (typeof (importObj as any).setExports === "function") {
    (importObj as any).setExports(instance.exports);
  }
  return (instance.exports as any).test();
}

async function runMulti(files: Record<string, string>): Promise<number> {
  const result = await compileMulti(files, "./test.ts", { skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  const importObj = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
  if (typeof (importObj as any).setExports === "function") {
    (importObj as any).setExports(instance.exports);
  }
  return (instance.exports as any).test();
}

describe("#2931 — live binding for reassigned function declarations", () => {
  it("a reassigned function name observes the new value on a later read", async () => {
    const ret = await runSingle(
      `function fn(){ fn = 2; return 1; }
       export function test(): number {
         const r = fn();
         if (r !== 1) return 100 + (r | 0);
         if ((fn as any) !== 2) return 200;
         return 1;
       }`,
    );
    expect(ret).toBe(1);
  });

  it("reading a reassigned function BEFORE the reassignment still yields the function (seed)", async () => {
    // `g` captures `fn` before `fn = 2`; calling `g()` must still invoke the fn.
    const ret = await runSingle(
      `function fn(){ return 7; }
       export function test(): number { const g: any = fn; fn = 2; return g(); }`,
    );
    expect(ret).toBe(7);
  });

  it("a plain (never-reassigned) function is unaffected (no regression)", async () => {
    const ret = await runSingle(`function fn(){ return 5; } export function test(): number { return fn(); }`);
    expect(ret).toBe(5);
  });

  it("an object-destructuring reassignment is observed by later reads", async () => {
    const ret = await runSingle(
      `export function test(): number {
         function fn(){ return 1; }
         function replacement(){ return 9; }
         const original: any = fn;
         if (original() !== 1) return 100;
         ({ current: fn } = { current: replacement });
         const current: any = fn;
         return current();
       }`,
    );
    expect(ret).toBe(9);
  });

  it("a var declaration-list for-of target updates the hoisted function binding", async () => {
    const ret = await runSingle(
      `export function test(): number {
         function fn(){ return 1; }
         function replacement(){ return 9; }
         const before: any = fn;
         if (before() !== 1) return 100;
         for (var fn of [replacement]) {}
         const after: any = fn;
         return after();
       }`,
    );
    expect(ret).toBe(9);
  });

  it("cross-module default import observes a reassignment of the default-exported function", async () => {
    // The #2900 shape (indirect default binding update), isolated to `.ts`
    // fixtures. The real test262 `.js` case additionally needs #2932.
    const ret = await runMulti({
      "./test.ts": `import val from "./h.ts";
        export function test(): number {
          const r = val();
          if (r !== 1) return 100 + (r | 0);
          if ((val as any) !== 2) return 200;
          return 1;
        }`,
      "./h.ts": `export default function fn(){ fn = 2; return 1; }`,
    });
    expect(ret).toBe(1);
  });
});
