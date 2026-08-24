// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest deepCyclicCopy keepPrototype family): `Object.getPrototypeOf`
// on a fnctor instance (`new F()` where F is a function expression) answered
// null — the __getPrototypeOf resolver only did the native read, blind to the
// fnctor instance→ctor `.prototype` link that [[Get]]/for-in already consult
// (_structUserProto). It now resolves the explicit setPrototypeOf record,
// then the vivified ctor prototype, so §20.2.4.3: getPrototypeOf(new F())
// === F.prototype even when F.prototype was never touched, and
// Object.create(getPrototypeOf(x)) round-trips.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-fnctor-getproto.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4616 Object.getPrototypeOf on fnctor instances", () => {
  it("answers the ctor's .prototype and round-trips through Object.create", async () => {
    const exp = await run(`
      export function t(): string {
        const Ctor: any = function () {};
        const a: any = new Ctor();
        const p1 = Object.getPrototypeOf(a);
        const same = p1 === Ctor.prototype;
        const b: any = Object.create(p1);
        const p2 = Object.getPrototypeOf(b);
        return String(p1 === null) + "," + String(same) + "," + String(p2 === p1);
      }`);
    expect(exp.t!()).toBe("false,true,true");
  });

  it("inline new (function(){})() gets a non-null prototype usable by Object.create", async () => {
    const exp = await run(`
      export function t(): string {
        const src: any = new (function (this: any) {
          this.length = 0;
        } as any)();
        const p = Object.getPrototypeOf(src);
        const c: any = Object.create(p);
        return String(p === null) + "," + String(Object.getPrototypeOf(c) === p);
      }`);
    expect(exp.t!()).toBe("false,true");
  });
});
