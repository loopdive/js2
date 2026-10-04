// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

async function context() {
  const result = await compile(
    `
let result:any;
export function capture(value:any):void {result=value;}
export function captured():any {return result;}
export function realm():any {return globalThis;}
export function get(object:any,key:any,receiver:any):any {return Reflect.get(object,key,receiver);}
export function key():any {return Symbol.iterator;}
export function wrongKey():any {return Symbol.hasInstance;}
export function nextKey():any {return "next";}
export function args():any {return [];}
export function arrayPrototype():any {return Array.prototype;}
export function call(fn:any,receiver:any,args:any):any {return fn.apply(receiver,args);}
export function f64Array():any {return [1.1,2.2];}
export function valueKey():any {return "value";}
export function number(value:any):number {return Number(value);}
export function kind(value:any):number {return typeof value === "function"?1:value===undefined?0:2;}
`,
    { target: "standalone", standaloneAllocationOwnerExport: "owns" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
}

const options = {
  target: "standalone",
  scriptGoal: true,
  allowJs: true,
  fileName: "script.ts",
  hostBridge: "always",
  deferTopLevelInit: true,
  standaloneScriptVarBindings: true,
  standaloneGlobalThisImport: { module: "context", name: "realm", owns: "owns", get: "get", exceptionTag: "__exn_tag" },
  standaloneScriptCompletionImport: { module: "context", name: "capture" },
  standaloneAllocationOwnerExport: "localOwns",
  standaloneScriptGetExport: "scriptGet",
  standaloneScriptCallExport: "scriptCall",
  link: ["context"],
} as const;

it("materializes a computed iterator method for owning-Script dynamic lookup", async () => {
  const owner = await context();
  const result = await compile("({[Symbol.iterator](){return {next:1};}})", { ...options, link: [...options.link] });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>;
  const s = script.exports as Record<string, Function>;
  s.__module_init();
  const object = e.captured();
  expect(s.localOwns(object)).toBe(1);
  const method = s.scriptGet(object, e.key());
  expect(e.kind(method)).toBe(1);
  const iterator = s.scriptCall(method, object, e.args());
  expect(e.number(s.scriptGet(iterator, e.nextKey()))).toBe(1);
  expect(e.kind(s.scriptGet(object, e.wrongKey()))).toBe(0);
  expect(s.localOwns(e.realm())).toBe(0);
});

it("reads shared Array iterator after own property miss", async () => {
  const owner = await context();
  const linked = { ...options.standaloneGlobalThisImport, arrayPrototype: "arrayPrototype" };
  const result = await compile("[70000]", { ...options, standaloneGlobalThisImport: linked, link: [...options.link] });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const s = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports })
    .exports as Record<string, Function>;
  const e = owner.exports as Record<string, Function>;
  s.__module_init();
  const array = e.captured();
  const method = s.scriptGet(array, e.key());
  expect(e.kind(method)).toBe(1);
  const iterator = e.call(method, array, e.args());
  const next = e.get(iterator, e.nextKey(), iterator);
  const step = e.call(next, iterator, e.args());
  expect(e.number(e.get(step, e.valueKey(), step))).toBe(70000);
});

it("does not publish the native getter without the explicit option", async () => {
  const { standaloneScriptGetExport: _unused, standaloneScriptCallExport: _unusedCall, ...base } = options;
  const result = await compile("42;", { ...base, link: [...base.link] });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.Module.exports(new WebAssembly.Module(result.binary)).some((e) => e.name === "scriptGet")).toBe(
    false,
  );
});

it("refuses a getter without allocation ownership", async () => {
  const { standaloneAllocationOwnerExport: _unused, ...base } = options;
  await expect(compile("42;", { ...base, link: [...base.link] })).rejects.toThrow(/allocation ownership/);
});
