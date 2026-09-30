// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { readFileSync } from "node:fs";
import { buildRuntimeEvalRefusalProviderSource } from "../scripts/runtime-eval-provider.mjs";

it.each(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"])(
  "preserves %s constructed through a function parameter",
  async (name) => {
    const result = await compile(
      `
      let reads=0; let conversions=0;
      function message():any {reads++;return {toString():string {conversions++;return "native op failure";}};}
      function construct(errorClass:any, message:any):any {return new errorClass(message);}
      export function run():number {
        const error=construct(${name}, message());
        if (error === null || error === undefined) return -1;
        if (error.name !== "${name}") return -2;
        if (reads !== 1 || conversions !== 1) return -4;
        return error.message === "native op failure" ? 42 : -3;
      }
      `,
      { target: "standalone", platform: "deno" },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
    (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.run as Function)()).toBe(42);
  },
);

it("keeps a user constructor passed through a parameter and evaluates its argument once", async () => {
  const result = await compile(
    `
    let reads=0; let calls=0;
    class Custom {value:number;constructor(value:number){calls++;this.value=value+1;}}
    function argument():number {reads++;return 41;}
    function construct(ctor:any,value:number):any {return new ctor(value);}
    export function run():number {
      const result=construct(Custom,argument());
      return result instanceof Custom && reads===1 && calls===1 ? result.value : -1;
    }
    `,
    { target: "standalone", platform: "deno" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
  (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  expect((instance.exports.run as Function)()).toBe(42);
});

it.each(["Error", "(globalThis as any).Error"])(
  "preserves errors constructed through a captured primordial %s",
  async (constructorSource) => {
    const result = await compile(
      `
      const CapturedError: any = ${constructorSource};
      export function run(): number {
        try { throw new CapturedError("Too many arguments"); }
        catch (error: any) {
          if (error === null) return -1;
          if (!(error instanceof Error)) return -2;
          return error.message === "Too many arguments" ? 42 : -3;
        }
      }
      export function control(): number {
        try { throw new Error("Too many arguments"); }
        catch (error: any) { return error.message === "Too many arguments" ? 42 : -4; }
      }
    `,
      { target: "standalone", platform: "deno", hostBridge: "always" },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
    (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = instance.exports as unknown as { run(): number; control(): number };
    expect(exports.control()).toBe(42);
    expect(exports.run()).toBe(42);
  },
);

it.each(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"])(
  "constructs a renamed destructured %s exactly once",
  async (name) => {
    const result = await compile(
      `
      let reads=0; let conversions=0;
      function bag():any { reads++; return {${name}: ${name}}; }
      const {${name}: Captured}: any = bag();
      export function run():number {
        const message={toString():string {conversions++;return "message";}};
        const error=new Captured(message);
        if (!(error instanceof ${name}) || error.name !== "${name}" || error.message !== "message") return -1;
        return reads*10+conversions;
      }
    `,
      { target: "standalone", platform: "deno" },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
    (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.run as Function)()).toBe(11);
  },
);

it("does not replace a user constructor stored under the Error key", async () => {
  const result = await compile(
    `
    class Custom {value:number;constructor(value:number){this.value=value+1;}}
    const source:any={Error:Custom};
    const {Error:Captured}=source;
    export function run():number {const value=new Captured(41);return value instanceof Custom ? value.value : -1;}
  `,
    { target: "standalone", platform: "deno" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
  (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  expect((instance.exports.run as Function)()).toBe(42);
});

it("preserves the real primordial Error in upstream async stub refusal", async () => {
  const sources = ["00_primordials.js", "00_infra.js"]
    .map(
      (name, index) =>
        `function phase${index}(): void {\n${readFileSync(new URL(`./fixtures/deno-core-0.407.0/${name}`, import.meta.url), "utf8")}\n}`,
    )
    .join("\n");
  const result = await compileMulti(
    {
      "/core/entry.ts": `
    ${buildRuntimeEvalRefusalProviderSource()}
    ${sources}
    (globalThis as any).Deno = {core: {ops: {}}};
    phase0(); phase1();
    export function run(): number {
      const op = function(a:any,b:any,c:any,d:any,e:any,f:any,g:any,h:any,i:any,j:any,k:any):any {};
      try { (globalThis as any).Deno.core.setUpAsyncStub("op_many",op); }
      catch (error:any) {
        if (error === null) return -1;
        if (error === undefined) return -2;
        return error.message.includes("Too many arguments") ? 42 : -3;
      }
      return -4;
    }
  `,
    },
    "/core/entry.ts",
    { target: "standalone", platform: "deno", allowJs: true, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
  (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  expect((instance.exports.run as Function)()).toBe(42);
});
