// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileMultiSource } from "../src/compiler.js";

it.each([false, true])("reads typed live imports from their original owner (IR=%s)", async (experimentalIR) => {
  const provider = await compile(
    `let left:number=77; const ns={get left(){return left;}};
     export function namespace():any {return ns;}
     export function change(value:number):void {left=value;}
     export function key():any {return "left";}
     export function realm():any {return globalThis;}
     export function get(object:any,key:any,receiver:any):any {return Reflect.get(object,key,receiver);}`,
    { target: "standalone", hostBridge: "always", standaloneAllocationOwnerExport: "owns" },
  );
  expect(provider.success, JSON.stringify(provider.errors)).toBe(true);
  const owner = new WebAssembly.Instance(new WebAssembly.Module(provider.binary), provider.importObject);
  (provider.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(owner);
  const result = await compileMultiSource(
    {
      "dep.ts": "let left:number=0; left=left+2; export {left};",
      "entry.ts": `import {left} from './dep';
        let right:number=0; right=left+3;
        export function initialized():number {return right;}
        export function keyLength(value:any):number {return String(value).length;}
        export function keyUnit(value:any,index:number):number {return String(value).charCodeAt(index);}
        export function live():number {return left+3;}`,
    },
    "entry.ts",
    {
      target: "standalone",
      hostBridge: "always",
      experimentalIR,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
      standaloneGlobalThisImport: {
        module: "context",
        name: "realm",
        owns: "owns",
        get: "get",
        exceptionTag: "__exn_tag",
      },
      standaloneModuleNamespaceImports: { module: "modules", sources: { "dep.ts": "dependency" } },
      link: ["context", "modules"],
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const wasm = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(wasm).filter((entry) => entry.module === "modules")).toEqual([
    { module: "modules", name: "dependency", kind: "function" },
  ]);
  let reads = 0;
  const instance = new WebAssembly.Instance(wasm, {
    // Explicit key-transport control: decode with the allocating graph, then
    // mint the property key in the receiver's owner. This isolates compiler
    // live-read semantics from cross-module string-type compatibility.
    context: {
      ...owner.exports,
      get: (object: unknown, key: unknown, receiver: unknown) => {
        expect(object).toBe((owner.exports.namespace as () => unknown)());
        expect(receiver).toBe(object);
        const length = (instance.exports.keyLength as (value: unknown) => number)(key);
        const units = Array.from({ length }, (_, index) =>
          (instance.exports.keyUnit as (value: unknown, index: number) => number)(key, index),
        );
        expect(String.fromCharCode(...units)).toBe("left");
        reads++;
        return (owner.exports.get as (object: unknown, key: unknown, receiver: unknown) => unknown)(
          object,
          (owner.exports.key as () => unknown)(),
          receiver,
        );
      },
    },
    modules: { dependency: owner.exports.namespace },
  });
  (instance.exports.__module_init as () => void)();
  expect((instance.exports.initialized as () => number)()).toBe(80);
  expect((instance.exports.live as () => number)()).toBe(80);
  (owner.exports.change as (value: number) => void)(91);
  expect((instance.exports.live as () => number)()).toBe(94);
  expect((instance.exports.initialized as () => number)()).toBe(80);
  expect(reads).toBe(3);
  const local = new WebAssembly.Instance(wasm, {
    context: owner.exports,
    modules: { dependency: () => null },
  });
  (local.exports.__module_init as () => void)();
  expect((local.exports.initialized as () => number)()).toBe(5);
  expect((local.exports.live as () => number)()).toBe(5);
});
