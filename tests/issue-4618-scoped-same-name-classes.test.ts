// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: same-named nested class DECLARATIONS in different scopes silently
// shared ONE compiled identity — collection is name-keyed and the structMap
// guard no-oped the duplicate, so react's per-test `class Foo extends
// React.Component { … }` re-declarations all bound to the FIRST test's
// compiled class (methods answered the first declaration's bodies).
// Duplicates now get the same per-site synthetic identity class EXPRESSIONS
// use, resolved by declaration node (checker identity), with the scoped
// class VALUE bound to a same-named local at the declaration statement.
// Also fixed en route: `class Component extends React.Component` no longer
// trips the §15.7.1 own-name TDZ check on the property NAME.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-scoped-classes.ts",
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

describe("#4618 same-named nested classes are scoped per declaration", () => {
  it("each function's class answers its OWN method bodies", async () => {
    const exp = await run(`
      export function a(): any {
        class Foo { tag(): any { return "A"; } }
        return new Foo().tag();
      }
      export function b(): any {
        class Foo { tag(): any { return "B"; } }
        return new Foo().tag();
      }`);
    expect(exp.a!()).toBe("A");
    expect(exp.b!()).toBe("B");
  });

  it("a class named after its parent's property does not false-trip the TDZ check", async () => {
    const exp = await run(`
      const NS: any = { Component: function (this: any) {} };
      export function t(): any {
        class Component extends NS.Component {
          tag(): any { return "ok"; }
        }
        return new Component().tag();
      }
      export function t2(): any {
        class Component extends NS.Component {
          tag(): any { return "ok2"; }
        }
        return new Component().tag();
      }`);
    expect(exp.t!()).toBe("ok");
    expect(exp.t2!()).toBe("ok2");
  });
});

describe("#4618 same-layout sibling classes dispatch host-side by tag", () => {
  it("host method calls on instances of same-shaped same-named classes hit the right bodies", async () => {
    // Same field LAYOUT → one canonical WasmGC type → a bare ref.test arm
    // matched both; the first class's instance ran the sibling's method.
    const grabbed: unknown[] = [];
    (globalThis as Record<string, unknown>).__grab4618sc = (v: unknown) => {
      grabbed.push(v);
    };
    const result = await compile(
      `
      export function a(): any {
        class Foo { m(): any { return "A"; } }
        (globalThis as any).__grab4618sc(Foo);
        return 1;
      }
      export function b(): any {
        class Foo { m(): any { return "B"; } }
        (globalThis as any).__grab4618sc(Foo);
        return 1;
      }`,
      { testRuntime: true, fileName: "issue-4618-tag-dispatch.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, {
      signatures: (result as { exportSignatures?: unknown }).exportSignatures,
    }) as Record<string, () => unknown>;
    exp.a!();
    exp.b!();
    const [ClassA, ClassB] = grabbed as [
      new () => Record<string, () => unknown>,
      new () => Record<string, () => unknown>,
    ];
    // host-side [[Construct]] through the #4618 bridge tags the instances,
    // and the tag-guarded dispatch arms pick each class's OWN method body.
    const ia = new ClassA();
    const ib = new ClassB();
    expect(typeof ia.m).toBe("function");
    expect(ia.m!()).toBe("A");
    expect(ib.m!()).toBe("B");
  });
});
