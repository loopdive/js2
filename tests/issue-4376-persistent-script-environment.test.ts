// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

async function createRealm() {
  const result = await compile(
    `
    export function realm():any {return globalThis;}
    export function get(object:any,key:any,receiver:any):any {return Reflect.get(object,key,receiver);}
    export function observed():number {return (globalThis as any).published===42 ? 42 : -1;}
  `,
    { target: "standalone", standaloneAllocationOwnerExport: "owns" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
}

async function runScript(owner: WebAssembly.Instance, source: string) {
  const result = await compile(source, {
    target: "standalone",
    scriptGoal: true,
    allowJs: true,
    standaloneAllocationOwnerExport: "localOwns",
    standaloneGlobalThisImport: {
      module: "context",
      name: "realm",
      owns: "owns",
      get: "get",
      exceptionTag: "__exn_tag",
    },
    link: ["context"],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
}

it("executes explicit property writes in the shared realm without wrapping Script source", async () => {
  const realm = await createRealm();
  await runScript(realm, "globalThis.published=41;");
  expect((realm.exports.observed as Function)()).toBe(-1);
  await runScript(realm, "globalThis.published=42;");
  expect((realm.exports.observed as Function)()).toBe(42);
});

// Expected failures are acceptance gaps, not passing conformance credit.
// Remove `.fails` when canonical persistent Script bindings are implemented.
it.fails("publishes Script var initialization and assignment to the shared global object", async () => {
  const realm = await createRealm();
  await runScript(realm, "var published=41; published=42;");
  expect((realm.exports.observed as Function)()).toBe(42);
});

it.fails("retains Script lexical bindings for a later independently compiled Script", async () => {
  const realm = await createRealm();
  await runScript(realm, "let retained=41;");
  await runScript(realm, "retained+=1; globalThis.published=retained;");
  expect((realm.exports.observed as Function)()).toBe(42);
});
