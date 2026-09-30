// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileMultiSource } from "../src/compiler.js";
import { prepareNamespaceGraph } from "../examples/v8x-js2wasm-spike/compile-graph.js";
import { readFileSync } from "node:fs";

it("reads core bindings from the owning bootstrap realm in a separately compiled graph", async () => {
  const provider = await compile(
    `
    const core:any={answer:42};
    const internals:any={marker:1};
    const primordials:any={marker:2};
    const bootstrap={primordials};
    (globalThis as any).__bootstrap=bootstrap;
    Object.assign(bootstrap,{core,internals});
    Object.defineProperty(bootstrap,"observed",{get(){return this.marker;}});
    const failure={token:42};
    Object.defineProperty(bootstrap,"failure",{get(){throw failure;}});
    export function originalFailure():any {return failure;}
    export function get(object:any,key:any,receiver:any):any {
      const value=Reflect.get(object,key,receiver);
      return value;
    }
    export function realm():any {return globalThis;}
    `,
    { target: "standalone", platform: "deno", hostBridge: "always", standaloneAllocationOwnerExport: "owns" },
  );
  expect(provider.success, JSON.stringify(provider.errors)).toBe(true);
  const owner = new WebAssembly.Instance(new WebAssembly.Module(provider.binary), provider.importObject);
  (provider.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(owner);
  const sources = prepareNamespaceGraph(
    new Map([
      ["ext:core/mod.js", readFileSync(new URL("./fixtures/deno-core-0.407.0/mod.js", import.meta.url), "utf8")],
      [
        "ext:///main_module.js",
        `
      import {core,internals,primordials} from "ext:core/mod.js";
      export function run() {
        if (core===undefined) return -1;
        if (internals===undefined) return -2;
        if (primordials===undefined) return -3;
        return core.answer===42 && internals.marker===1 && primordials.marker===2 ? 42 : -4;
      }
      export function local() {
        const bootstrap:any={primordials:{marker:2}};
        Object.assign(bootstrap,{core:{answer:83},internals:{marker:9}});
        return bootstrap.core.answer;
      }
      export function receiver() {
        const bootstrap=(globalThis as any).__bootstrap;
        return Reflect.get(bootstrap,"observed",bootstrap.primordials);
      }
      export function caught() {
        try { return (globalThis as any).__bootstrap.failure; }
        catch (reason) { return reason; }
      }
      `,
      ],
    ]),
    "ext:///main_module.js",
  );
  const graph = await compileMultiSource(
    sources.files,
    sources.entry,
    {
      target: "standalone",
      standaloneAllocationOwnerExport: "localOwns",
      platform: "deno",
      hostBridge: "always",
      allowJs: true,
      standaloneGlobalThisImport: {
        module: "context",
        name: "realm",
        owns: "owns",
        get: "get",
        exceptionTag: "__exn_tag",
      },
      link: ["context"],
    },
    undefined,
    sources.projectResolutions,
  );
  expect(graph.success, JSON.stringify(graph.errors)).toBe(true);
  const application = new WebAssembly.Instance(new WebAssembly.Module(graph.binary), {
    context: {
      realm: owner.exports.realm,
      owns: owner.exports.owns,
      get: owner.exports.get,
      __exn_tag: owner.exports.__exn_tag,
    },
  });
  expect((application.exports.run as Function)()).toBe(42);
  expect((application.exports.local as Function)()).toBe(83);
  expect((application.exports.receiver as Function)()).toBe(2);
  expect((application.exports.caught as Function)()).toBe((owner.exports.originalFailure as Function)());
});

it("delegates foreign argument reads without requiring a globalThis expression", async () => {
  const provider = await compile(
    `
    const object:any={marker:1};
    Object.assign(object,{answer:42});
    export function original():any {return object;}
    export function realm():any {return globalThis;}
    export function get(value:any,key:any,receiver:any):any {return Reflect.get(value,key,receiver);}
  `,
    { target: "standalone", standaloneAllocationOwnerExport: "owns" },
  );
  expect(provider.success, JSON.stringify(provider.errors)).toBe(true);
  const owner = new WebAssembly.Instance(new WebAssembly.Module(provider.binary), provider.importObject);
  const consumer = await compile(`export function read(value:any):any {return value.answer;}`, {
    target: "standalone",
    standaloneAllocationOwnerExport: "localOwns",
    standaloneGlobalThisImport: { module: "context", name: "realm", owns: "owns", get: "get" },
    link: ["context"],
  });
  expect(consumer.success, JSON.stringify(consumer.errors)).toBe(true);
  const application = new WebAssembly.Instance(new WebAssembly.Module(consumer.binary), { context: owner.exports });
  expect((application.exports.read as Function)((owner.exports.original as Function)())).toBe(42);
});

it("rejects an incomplete ownership ABI", async () => {
  for (const extra of [{ owns: "owns" }, { get: "get" }, { owns: "", get: "get" }]) {
    await expect(
      compile("export function read():number {return 42;}", {
        target: "standalone",
        standaloneGlobalThisImport: { module: "context", name: "realm", ...extra },
        link: ["context"],
      }),
    ).rejects.toThrow("owns and get must be provided together");
  }
});
