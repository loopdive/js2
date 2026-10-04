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
export function probeKey():any {return "receiverProbe";}
export function same(a:any,b:any):boolean {return a===b;}
export function expectedReceiver():any {return globalThis.expectedReceiver;}
export function installArrayProbe():void {
 Object.defineProperty(Array.prototype,"receiverProbe",{get(){return this;},configurable:true});
}
export function installIteratorProbe():void {
 const p:any=Object.getPrototypeOf(Array.prototype[Symbol.iterator]());
 Object.defineProperty(p,"receiverProbe",{get(){return this;},configurable:true});
}
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

it.each([
  ["own undefined", "let a:any=[70000];a[Symbol.iterator]=undefined;a;"],
  ["own accessor", "let a:any=[70000];Object.defineProperty(a,Symbol.iterator,{get(){return undefined;}});a;"],
  ["ordinary object", "({})"],
  ["null prototype", "let a:any=[70000];Object.setPrototypeOf(a,null);a;"],
  ["custom prototype", "let a:any=[70000];Object.setPrototypeOf(a,{[Symbol.iterator]:undefined});a;"],
])("does not replace %s with the shared Array iterator", async (_label, source) => {
  const owner = await context();
  const result = await compile(source, {
    ...options,
    standaloneGlobalThisImport: { ...options.standaloneGlobalThisImport, arrayPrototype: "arrayPrototype" },
    link: [...options.link],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const s = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports })
    .exports as Record<string, Function>;
  const e = owner.exports as Record<string, Function>;
  s.__module_init();
  expect(e.kind(s.scriptGet(e.captured(), e.key()))).toBe(0);
});

it("refuses a getter without allocation ownership", async () => {
  const { standaloneAllocationOwnerExport: _unused, ...base } = options;
  await expect(compile("42;", { ...base, link: [...base.link] })).rejects.toThrow(/allocation ownership/);
});

it.each([
  ["prototype identity", "let a:any=[1];let p:any={};Object.setPrototypeOf(a,p);Object.getPrototypeOf(a)===p?1:0;"],
  ["null identity", "let a:any=[1];Object.setPrototypeOf(a,null);Object.getPrototypeOf(a)===null?1:0;"],
  [
    "own property after mutation",
    "let a:any=[1];a[Symbol.iterator]=42;Object.setPrototypeOf(a,null);a[Symbol.iterator]===42?1:0;",
  ],
  ["non-extensible refusal", "let a:any=[1];Object.preventExtensions(a);Reflect.setPrototypeOf(a,null)===false?1:0;"],
  ["cycle refusal", "let a:any=[1];let p:any={};Object.setPrototypeOf(p,a);Reflect.setPrototypeOf(a,p)===false?1:0;"],
])("preserves linked array %s", async (_label, source) => {
  const owner = await context();
  const result = await compile(source, {
    ...options,
    standaloneGlobalThisImport: { ...options.standaloneGlobalThisImport, arrayPrototype: "arrayPrototype" },
    link: [...options.link],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const s = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports })
    .exports as Record<string, Function>;
  const e = owner.exports as Record<string, Function>;
  s.__module_init();
  expect(e.number(e.captured())).toBe(1);
});

it.each([
  [
    "own accessor",
    'let a:any=[1];Object.defineProperty(a,"probe",{get(){return this.value;}});Reflect.get(a,"probe",{value:42});',
  ],
  [
    "custom prototype accessor",
    'let a:any=[1];Object.setPrototypeOf(a,{get probe(){return this.value;}});Reflect.get(a,"probe",{value:42});',
  ],
  [
    "nested own accessor",
    'let a:any=[1];a.value=7;Object.defineProperty(a,"probe",{get(){return this.value+a.value;}});Reflect.get(a,"probe",{value:35});',
  ],
  [
    "indexed accessor with numeric key",
    'let a:any=[1];Object.defineProperty(a,"0",{get(){return this.value;}});Reflect.get(a,0,{value:42});',
  ],
  [
    "indexed accessor with string key",
    'let a:any=[1];Object.defineProperty(a,"0",{get(){return this.value;}});Reflect.get(a,"0",{value:42});',
  ],
])("uses the explicit Reflect receiver for a linked array %s", async (_label, source) => {
  const owner = await context();
  const result = await compile(source, {
    ...options,
    standaloneGlobalThisImport: { ...options.standaloneGlobalThisImport, arrayPrototype: "arrayPrototype" },
    link: [...options.link],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const s = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports })
    .exports as Record<string, Function>;
  const e = owner.exports as Record<string, Function>;
  s.__module_init();
  expect(e.number(e.captured())).toBe(42);
});

it("preserves an explicit receiver through the shared Context Array prototype", async () => {
  const owner = await context();
  const e = owner.exports as Record<string, Function>;
  e.installArrayProbe();
  const result = await compile(
    'let a:any=[1];let r:any={value:42};globalThis.expectedReceiver=r;Reflect.get(a,"receiverProbe",r);',
    {
      ...options,
      standaloneGlobalThisImport: { ...options.standaloneGlobalThisImport, arrayPrototype: "arrayPrototype" },
      link: [...options.link],
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const s = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports })
    .exports as Record<string, Function>;
  s.__module_init();
  expect(e.same(e.captured(), e.expectedReceiver())).toBe(1);
});

it("preserves an explicit receiver through the native Array iterator prototype", async () => {
  const owner = await context();
  const e = owner.exports as Record<string, Function>;
  e.installIteratorProbe();
  const array = e.f64Array();
  const iterator = e.call(e.get(e.arrayPrototype(), e.key(), array), array, e.args());
  const receiver = e.realm();
  expect(e.same(e.get(iterator, e.probeKey(), receiver), receiver)).toBe(1);
});
