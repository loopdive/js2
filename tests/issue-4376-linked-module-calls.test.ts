// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileMultiSource } from "../src/compiler.js";

it("keeps unmapped module compilation byte-identical", async () => {
  const sources = {
    "main.js": "import * as dep from './dep.js'; export function functionValue(){return dep.bump;}",
    "dep.js": "export function bump(){return 42;}",
  };
  const options = {
    target: "standalone" as const,
    hostBridge: "always" as const,
    allowJs: true,
    skipSemanticDiagnostics: true,
  };
  const plain = await compileMultiSource(sources, "main.js", options);
  const unmapped = await compileMultiSource(sources, "main.js", {
    ...options,
    standaloneModuleNamespaceImports: { module: "unused", sources: {} },
  });
  expect(plain.success, JSON.stringify(plain.errors)).toBe(true);
  expect(unmapped.success, JSON.stringify(unmapped.errors)).toBe(true);
  expect(unmapped.binary).toEqual(plain.binary);
});

it("calls original namespace functions with their own receiver state", async () => {
  const ownerResult = await compile(
    `let count=3;
     const ns:any=Object.create(null);
     ns.bump=function(){return ++count;};
     ns.receiver=function(){return this;};
     export function namespace():any {return ns;}
     export function current():number {return count;}
     export function isUndefined(value:any):number {return value===undefined?1:0;}
     export function originalBump():any {return ns.bump;}
     export function realm():any {return globalThis;}
     export function get(value:any,key:any,receiver:any):any {return Reflect.get(value,key,receiver);}
     export function call(fn:any,receiver:any,args:any):any {return fn.apply(receiver,args);}`,
    { target: "standalone", hostBridge: "always", standaloneAllocationOwnerExport: "owns" },
  );
  expect(ownerResult.success, JSON.stringify(ownerResult.errors)).toBe(true);
  const owner = new WebAssembly.Instance(new WebAssembly.Module(ownerResult.binary), ownerResult.importObject);
  (ownerResult.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void })?.__setInstance?.(owner);
  const options = {
    target: "standalone" as const,
    allowJs: true,
    hostBridge: "always" as const,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    standaloneAllocationOwnerExport: "localOwns",
    standaloneGlobalThisImport: {
      module: "context",
      name: "realm",
      owns: "owns",
      get: "get",
      call: "call",
      exceptionTag: "__exn_tag",
    },
    standaloneModuleNamespaceImports: { module: "modules", sources: { "dep.js": "dependency" } },
    link: ["context", "modules"],
  };
  const result = await compileMultiSource(
    {
      "main.js": `import * as ns from './dep.js'; import { bump, receiver } from './dep.js';
      export function mutate():any {return ns.bump();}
      export function named():any {return bump();}
      export function methodReceiver():any {return ns.receiver();}
      export function bareReceiver():any {return receiver();}
      export function readFunction():any {return ns.bump;}`,
      "dep.js": `throw new Error('evaluated dependency was rerun');
      export function bump(){return 1;}
      export function receiver(){return this;}`,
    },
    "main.js",
    options,
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module).filter((i) => i.module === "modules")).toEqual([
    { module: "modules", name: "dependency", kind: "function" },
  ]);
  const instance = new WebAssembly.Instance(module, {
    context: owner.exports,
    modules: { dependency: owner.exports.namespace },
  });
  (instance.exports.__module_init as () => void)();
  const namespace = (owner.exports.namespace as () => unknown)();
  expect((instance.exports.mutate as () => unknown)()).toBeDefined();
  expect((owner.exports.current as () => number)()).toBe(4);
  (instance.exports.named as () => unknown)();
  expect((owner.exports.current as () => number)()).toBe(5);
  expect((instance.exports.methodReceiver as () => unknown)()).toBe(namespace);
  expect(
    (owner.exports.isUndefined as (value: unknown) => number)((instance.exports.bareReceiver as () => unknown)()),
  ).toBe(1);
  expect((instance.exports.readFunction as () => unknown)()).toBe((owner.exports.originalBump as () => unknown)());
});
