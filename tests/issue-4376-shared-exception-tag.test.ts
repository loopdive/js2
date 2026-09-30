// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("catches a linked realm exception by shared tag identity without copying its payload", async () => {
  const provider = await compile(
    `
    const marker = { token: 42 };
    export function original():any { return marker; }
    export function fail():void { throw marker; }
    export function global():any { return globalThis; }
  `,
    { target: "standalone", hostBridge: "always" },
  );
  expect(provider.success, JSON.stringify(provider.errors)).toBe(true);
  const realm = new WebAssembly.Instance(new WebAssembly.Module(provider.binary), provider.importObject ?? {});
  const marker = (realm.exports.original as () => unknown)();
  for (const shared of [false, true]) {
    const consumer = await compile(
      `
      declare function fail():void;
      export function run():any {
        try { fail(); return undefined; }
        catch (reason) { return reason; }
      }
    `,
      {
        target: "standalone",
        hostBridge: "always",
        externImportModule: "realm",
        link: ["realm"],
        standaloneGlobalThisImport: {
          module: "realm",
          name: "global",
          ...(shared ? { exceptionTag: "__exn_tag" } : {}),
        },
      },
    );
    expect(consumer.success, JSON.stringify(consumer.errors)).toBe(true);
    const module = new WebAssembly.Module(consumer.binary);
    const tags = WebAssembly.Module.imports(module).filter((entry) => entry.kind === "tag");
    expect(tags).toEqual(shared ? [{ module: "realm", name: "__exn_tag", kind: "tag" }] : []);
    const instance = new WebAssembly.Instance(module, { ...consumer.importObject, realm: realm.exports });
    const run = instance.exports.run as () => unknown;
    if (shared) expect(run()).toBe(marker);
    else expect(run).toThrow();
  }
});
