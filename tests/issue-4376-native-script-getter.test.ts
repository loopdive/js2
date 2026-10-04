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
export function zeroKey():any {return "0";}
export function oneKey():any {return "1";}
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
export function namesProbe(value:any):number {
 if(value.length!==2)return -1;
 if(value[0]==="foo"&&value[1]==="bar")return 1;
 if(value[0]==="hidden"&&value[1]==="getter")return 2;
 return 0;
}
export function nameCode(value:any,index:number):number {
 const key:any=value[index];
 return key==="foo"?1:key==="bar"?2:key==="hidden"?3:key==="getter"?4:key==="2"?5:key==="10"?6:key==="01"?7:key==="4294967295"?8:key==="0"?9:key==="1"?10:key==="length"?11:0;
}
export function length(value:any):number {return value.length;}
export function first(value:any):any {return value[0];}
export function registrySame(a:any,b:any):boolean {return a[1]===b[1]&&a[2]===b[2];}
export function descriptorBits(value:any):number {return (value.writable?1:0)+(value.enumerable?2:0)+(value.configurable?4:0);}
export function fooKey():any {return "foo";}
export function hiddenKey():any {return "hidden";}
export function getterKey():any {return "getter";}
`,
    { target: "standalone", standaloneAllocationOwnerExport: "owns", standaloneSymbolState: "export" },
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
  standaloneSymbolState: { module: "context" },
  link: ["context"],
} as const;

const reflectionOptions = {
  ...options,
  standaloneScriptOwnNamesExport: "scriptOwnNames",
  standaloneScriptReflectionExports: { ownSymbols: "scriptOwnSymbols", descriptor: "scriptDescriptor" },
};

it("shares Symbol allocation and registry state without merging distinct user symbols", async () => {
  const owner = await context();
  const e = owner.exports as Record<string, Function>;
  const values: unknown[] = [];
  for (let index = 0; index < 2; index++) {
    const result = await compile('[Symbol("same"),Symbol.for("shared"),Symbol.iterator]', {
      ...options,
      link: [...options.link],
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
    (instance.exports.__module_init as Function)();
    values.push(e.captured());
  }
  expect(e.same(e.first(values[0]), e.first(values[1]))).toBe(0);
  expect(e.registrySame(values[0], values[1])).toBe(1);
});

it("reflects ordinary data and accessor descriptors without invoking the getter", async () => {
  const owner = await context();
  const result = await compile(
    `
var object:any={foo:1};
Object.defineProperty(object,"hidden",{value:2,enumerable:false,writable:false,configurable:true});
Object.defineProperty(object,"getter",{get(){throw new Error("must not run");},enumerable:true,configurable:false});
object;
`,
    { ...reflectionOptions, link: [...options.link] },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>,
    s = script.exports as Record<string, Function>;
  s.__module_init();
  const object = e.captured();
  expect(e.descriptorBits(s.scriptDescriptor(object, e.fooKey()))).toBe(7);
  expect(e.descriptorBits(s.scriptDescriptor(object, e.hiddenKey()))).toBe(4);
  expect(e.descriptorBits(s.scriptDescriptor(object, e.getterKey()))).toBe(2);
});

it("preserves symbol key identity and descriptor flags on an open native Script object", async () => {
  const owner = await context();
  const result = await compile(
    `
var object:any={foo:1};
Object.defineProperty(object,Symbol.iterator,{value:2,enumerable:false,writable:false,configurable:true});
object;
`,
    { ...reflectionOptions, link: [...options.link] },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>,
    s = script.exports as Record<string, Function>;
  s.__module_init();
  const object = e.captured(),
    symbols = s.scriptOwnSymbols(object);
  expect(e.length(symbols)).toBe(1);
  expect(e.same(e.first(symbols), e.key())).toBe(1);
  expect(e.length(s.scriptOwnNames(object))).toBe(1);
  expect(e.descriptorBits(s.scriptDescriptor(object, e.first(symbols)))).toBe(4);
});

it("enumerates a closed computed symbol method without leaking its internal string field", async () => {
  const owner = await context();
  const result = await compile("({foo:1,[Symbol.iterator](){return [];}})", {
    ...reflectionOptions,
    link: [...options.link],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>,
    s = script.exports as Record<string, Function>;
  s.__module_init();
  const object = e.captured(),
    symbols = s.scriptOwnSymbols(object);
  expect(e.length(symbols)).toBe(1);
  expect(e.same(e.first(symbols), e.key())).toBe(1);
  expect(e.length(s.scriptOwnNames(object))).toBe(1);
  expect(e.descriptorBits(s.scriptDescriptor(object, e.first(symbols)))).toBe(7);
});

it("enumerates closed Script fields without copying values into the Context", async () => {
  const owner = await context();
  const result = await compile("({foo:1, bar:{value:2}})", {
    ...options,
    standaloneScriptOwnNamesExport: "scriptOwnNames",
    link: [...options.link],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>;
  const s = script.exports as Record<string, Function>;
  s.__module_init();
  const object = e.captured();
  expect(s.localOwns(object)).toBe(1);
  const names = s.scriptOwnNames(object);
  expect([e.nameCode(names, 0), e.nameCode(names, 1)]).toEqual([1, 2]);
});

it("does not invoke accessors or include inherited fields while enumerating own names", async () => {
  const owner = await context();
  const result = await compile(
    `
const object:any=Object.create({inherited:1});
Object.defineProperty(object,"hidden",{value:2,enumerable:false});
Object.defineProperty(object,"getter",{get(){throw new Error("must not run");},enumerable:true});
object;
`,
    { ...options, standaloneScriptOwnNamesExport: "scriptOwnNames", link: [...options.link] },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>;
  const s = script.exports as Record<string, Function>;
  s.__module_init();
  expect(e.namesProbe(s.scriptOwnNames(e.captured()))).toBe(2);
});

it("distinguishes equal physical fields with opposite source insertion orders", async () => {
  const owner = await context();
  const result = await compile("[({foo:1,bar:2}),({bar:3,foo:4})]", {
    ...options,
    standaloneScriptOwnNamesExport: "scriptOwnNames",
    link: [...options.link],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>;
  const s = script.exports as Record<string, Function>;
  s.__module_init();
  const pair = e.captured();
  // The Context reads the pair's shared native array representation, but each
  // object must be enumerated by its allocation owner, with its own stamp.
  const first = s.scriptGet(pair, e.zeroKey());
  const second = s.scriptGet(pair, e.oneKey());
  const a = s.scriptOwnNames(first);
  const b = s.scriptOwnNames(second);
  expect([e.nameCode(a, 0), e.nameCode(a, 1)]).toEqual([1, 2]);
  expect([e.nameCode(b, 0), e.nameCode(b, 1)]).toEqual([2, 1]);
});

it("orders array-index names numerically without treating numeric-looking strings as indices", async () => {
  const owner = await context();
  const result = await compile('({"10":1,"01":2,"2":3,"4294967295":4})', {
    ...options,
    standaloneScriptOwnNamesExport: "scriptOwnNames",
    link: [...options.link],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>;
  const s = script.exports as Record<string, Function>;
  s.__module_init();
  const names = s.scriptOwnNames(e.captured());
  expect([0, 1, 2, 3].map((index) => e.nameCode(names, index))).toEqual([5, 6, 7, 8]);
});

it("includes dense array indices and non-enumerable length without a source reflection call", async () => {
  const owner = await context();
  const result = await compile("[10,20]", {
    ...options,
    standaloneScriptOwnNamesExport: "scriptOwnNames",
    link: [...options.link],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const script = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
  const e = owner.exports as Record<string, Function>;
  const s = script.exports as Record<string, Function>;
  s.__module_init();
  const names = s.scriptOwnNames(e.captured());
  expect([0, 1, 2].map((index) => e.nameCode(names, index))).toEqual([9, 10, 11]);
});

it("refuses own-name export without the native getter and ownership mode", async () => {
  await expect(compile("1", { target: "standalone", standaloneScriptOwnNamesExport: "names" })).rejects.toThrow(
    "native Script getter/ownership",
  );
});

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
