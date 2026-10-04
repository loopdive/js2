// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { compile } from "../src/index.js";

async function createContext() {
  const provider = await readFile(
    new URL("../examples/v8x-js2wasm-spike/script-lexical-provider.ts", import.meta.url),
    "utf8",
  );
  const compiled = await compile(
    provider +
      `
let captured:any=undefined;
export function capture(value:any):void {captured=value;}
export function reset():void {captured=undefined;}
export function realm():any {return globalThis;}
export function get(o:any,k:any,r:any):any {return Reflect.get(o,k,r);}
export function kind():number {
  return captured===undefined?0:typeof captured==="number"?1:typeof captured==="boolean"?2:typeof captured==="string"?3:4;
}
export function number():number {return Number(captured);}
export function text():boolean {return captured==="text";}
export function identity():boolean {return captured===globalThis.saved;}
`,
    { target: "standalone", standaloneAllocationOwnerExport: "owns" },
  );
  expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(compiled.binary), compiled.importObject);
}

async function run(owner: WebAssembly.Instance, source: string, completion = true) {
  const compiled = await compile(source, {
    target: "standalone",
    scriptGoal: true,
    allowJs: true,
    fileName: "script.ts",
    hostBridge: "always",
    deferTopLevelInit: true,
    standaloneScriptVarBindings: true,
    standaloneGlobalThisImport: {
      module: "context",
      name: "realm",
      owns: "owns",
      get: "get",
      exceptionTag: "__exn_tag",
    },
    standaloneScriptLexicalImport: { module: "context", name: "scriptLexicalOperation" },
    ...(completion ? { standaloneScriptCompletionImport: { module: "context", name: "capture" } } : {}),
    standaloneAllocationOwnerExport: "localOwns",
    link: ["context"],
  });
  expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(compiled.binary), { context: owner.exports });
  (owner.exports.reset as Function)();
  const init = instance.exports.__module_init;
  if (init) (init as Function)();
  return compiled;
}

it.each([
  "42;",
  "41; 42;",
  "42;;",
  "42; const retained=1;",
  "if(true) 42; else 0;",
  "41; if(false) 0;",
  "{42;}",
  "41; label: {}",
  "41; while(false) 42;",
  "do {42;} while(false);",
  "for(let index=0;index<3;index++){index+40;}",
  "try {42;} finally {0;}",
  "try {41;throw 0;} catch(error) {42;} finally {0;}",
  "try {41;throw 0;} catch(error) {}",
  "void 42;",
  "true;",
  '"text";',
  "null;",
  "undefined;",
  "1|2;",
  "1===1;",
  "-42;",
  "42; function nested(){99;} nested();",
  "42; function nested(){99;}",
  "while(true){42;break;}",
  "for(let index=0;index<3;index++){index+40;continue;}",
  "outer: while(true){try {42;break outer;} finally {0;}}",
  "outer: while(true){try {42;} finally {0;break outer;}}",
  "switch(1){case 1:42;break;default:0;}",
  "41; switch(0){case 1:42;}",
])("publishes actual Script completion for %s", async (source) => {
  const expected = new Script(source).runInNewContext();
  const owner = await createContext();
  await run(owner, source);
  const kind =
    expected === undefined
      ? 0
      : typeof expected === "number"
        ? 1
        : typeof expected === "boolean"
          ? 2
          : typeof expected === "string"
            ? 3
            : 4;
  expect((owner.exports.kind as Function)()).toBe(kind);
  if (kind === 1 || kind === 2) expect((owner.exports.number as Function)()).toBe(Number(expected));
  if (kind === 3) expect((owner.exports.text as Function)()).toBe(1);
});

it("keeps object completion identity instead of serializing a copy", async () => {
  const owner = await createContext();
  await run(owner, "globalThis.saved={marker:42}; globalThis.saved;");
  expect((owner.exports.identity as Function)()).toBe(1);
});

it("does not publish a successful completion after an uncaught throw", async () => {
  const owner = await createContext();
  await expect(run(owner, "41; throw 42;")).rejects.toBeInstanceOf(WebAssembly.Exception);
  expect((owner.exports.kind as Function)()).toBe(0);
});

it("resets completion between independently executed Scripts", async () => {
  const owner = await createContext();
  await run(owner, "42;");
  expect((owner.exports.number as Function)()).toBe(42);
  await run(owner, "void 0;");
  expect((owner.exports.kind as Function)()).toBe(0);
});

it("does not add a completion import when the option is absent", async () => {
  const owner = await createContext();
  const compiled = await run(owner, "globalThis.saved=42;", false);
  expect(
    WebAssembly.Module.imports(new WebAssembly.Module(compiled.binary)).some(
      ({ module, name }) => module === "context" && name === "capture",
    ),
  ).toBe(false);
  expect((owner.exports.kind as Function)()).toBe(0);
});
