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

  it("a same-named FUNCTION in a sibling scope is not hijacked by the class singleton", async () => {
    // (#4618) The classObjectGlobals identifier branch resolved by NAME, so a
    // `class Foo` anywhere in the module made every same-named identifier —
    // including a sibling scope's `function Foo()` — read the class object.
    // react's StrictMode batch declares `class Foo` in one test and
    // `function Foo()` in the next; the function crossed to the host as the
    // class mirror and was never callable as itself. The branch now verifies
    // checker identity: a function/parameter/variable declaration opts out.
    const grabbed: unknown[] = [];
    (globalThis as Record<string, unknown>).__grab4618ck = (v: unknown) => {
      grabbed.push(v);
    };
    const result = await compile(
      `
      export function a(): any {
        class Foo { m(): any { return "class"; } }
        (globalThis as any).__grab4618ck(Foo);
        return 1;
      }
      export function b(): any {
        function Foo(): any { return "fn"; }
        (globalThis as any).__grab4618ck(Foo);
        return 1;
      }`,
      { testRuntime: true, fileName: "issue-4618-cross-kind.ts", skipSemanticDiagnostics: true },
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
    const [, F] = grabbed as [unknown, () => unknown];
    expect(typeof F).toBe("function");
    expect(F()).toBe("fn");
  });

  it("a sibling-scope function keeps its CAPTURES despite a same-named class (async callback lane)", async () => {
    // (#4618) `classSet` is name-keyed, so a class named Foo anywhere in the
    // module vetoed the funcref-as-value arm for a sibling scope's
    // `function Foo()` — inside a host callback the read fell through to the
    // graceful default and Foo crossed as a bare value whose captured-count
    // writes went nowhere (react StrictMode: fncount stayed 0). The veto now
    // yields when funcMapOwnerDecl proves the funcMap entry IS the declaration
    // this reference resolves to.
    (globalThis as Record<string, unknown>).__act4618cl = async (cb: () => void) => {
      cb();
    };
    let stored: (() => unknown) | null = null;
    (globalThis as Record<string, unknown>).__ce4618cl = (fn: () => unknown) => {
      stored = fn;
    };
    (globalThis as Record<string, unknown>).__invoke4618cl = () => (stored ? stored() : "no-stored");
    const result = await compile(
      `
      export async function drive(): Promise<any> {
        let count = 0;
        class Foo { render(): any { count++; return null; } }
        return "cls=" + String(count);
      }
      export async function drive2(): Promise<any> {
        const act: any = (globalThis as any).__act4618cl;
        let count = 0;
        function Foo(): any { count++; return null; }
        await act(() => { (globalThis as any).__ce4618cl(Foo); });
        (globalThis as any).__invoke4618cl();
        return "fncount=" + String(count);
      }`,
      { testRuntime: true, fileName: "issue-4618-cross-kind-captures.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, {
      signatures: (result as { exportSignatures?: unknown }).exportSignatures,
    }) as Record<string, () => Promise<unknown>>;
    const out = await exp.drive2!();
    expect(stored).not.toBeNull();
    expect(out).toBe("fncount=1");
  });

  it("a TOP-LEVEL function read as a value is not vetoed by a same-named nested class", async () => {
    // (#4618) The funcref-as-value arm's classSet veto is name-keyed, so a
    // nested `class Component` in ANY function vetoed value reads of the
    // module-level `function Component` — react's own
    // `exports.Component = Component` stored null under per-test class
    // declarations, so `React.Component` (and every class-component
    // detection) read back null. With no nested funcMap owner, a checker
    // resolution to a top-level FunctionDeclaration now lifts the veto.
    const exp = await run(`
      function Component(this: any, props: any): any { (this as any).props = props; }
      var exportsObj: any = {};
      exportsObj.Component = Component;
      export function other(): any {
        class Component { m(): any { return 1; } }
        return new Component().m();
      }
      export function t(): any {
        const v: any = exportsObj.Component;
        return v == null ? "NULL" : typeof v;
      }`);
    expect(exp.t!()).toBe("function");
    expect(exp.other!()).toBe(1);
  });

  it("F.prototype writes/reads on a top-level function are not hijacked by a same-named class", async () => {
    // (#4618) `.prototype` dispatch is display-name keyed: with a nested
    // `class F` anywhere in the module, `F.prototype` on the TOP-LEVEL
    // `function F` routed into the CLASS's proto singleton — the write
    // `F.prototype.mark = 1` landed in the class store while dynamic reads
    // (`obj.F.prototype.mark`) used the fn sidecar. react's
    // `Component.prototype.isReactComponent = {}` split the same way, so
    // react-dom never detected compiled class components. The class arms now
    // yield when the receiver checker-resolves to a function-like decl.
    const exp = await run(`
      function F(this: any): any {}
      (F as any).prototype.mark = 1;
      var obj: any = {};
      obj.F = F;
      export function other(): any {
        class F { m(): any { return 1; } }
        return new F().m();
      }
      export function t(): any {
        return String((F as any).prototype.mark) + "|" + String(obj.F.prototype.mark) + "|" + String(obj.F === F);
      }`);
    expect(exp.t!()).toBe("1|1|true");
    expect(exp.other!()).toBe(1);
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

  it("does not expose a method owned only by a same-layout sibling", async () => {
    // A method with only ONE dispatch entry still needs a tag guard. The
    // negative class is absent from that method's entry list, but its
    // same-layout instance passes the sibling's structural ref.test. React
    // observed a later test's UNSAFE_componentWillMount on an earlier Foo.
    let ClassA: (new () => Record<string, unknown>) | undefined;
    (globalThis as Record<string, unknown>).__grab4618sc = (v: unknown) => {
      ClassA = v as new () => Record<string, unknown>;
    };
    const result = await compile(
      `
      export function a(): any {
        class Foo { common(): any { return "A"; } }
        (globalThis as any).__grab4618sc(Foo);
        return 1;
      }
      export function b(): any {
        class Foo {
          common(): any { return "B"; }
          onlyOnB(): any { return "wrong"; }
        }
        return Foo;
      }`,
      { testRuntime: true, fileName: "issue-4618-absent-member-tag-dispatch.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, {
      signatures: (result as { exportSignatures?: unknown }).exportSignatures,
    }) as Record<string, () => unknown>;
    exp.a!();
    expect(ClassA).toBeDefined();
    const instanceA = new ClassA!();
    expect(instanceA.common).toBeTypeOf("function");
    expect(instanceA.onlyOnB).toBeUndefined();
  });

  it("a host write for one same-layout class does not overwrite a sibling field", async () => {
    const captured: unknown[] = [];
    (globalThis as Record<string, unknown>).__grab4618fields = (value: unknown) => {
      captured.push(value);
    };
    const result = await compile(
      `
      export function capture(): number {
        class Foo {
          mutativeValue: any = "keep";
          read(): any { return this.mutativeValue; }
        }
        (globalThis as any).__grab4618fields(Foo);
        class Bar {
          state: any = "initial";
          read(): any { return this.state; }
        }
        (globalThis as any).__grab4618fields(Bar);
        return 1;
      }`,
      { testRuntime: true, fileName: "issue-4618-tagged-field-setter.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, {
      signatures: (result as { exportSignatures?: unknown }).exportSignatures,
    }) as Record<string, () => unknown>;
    exp.capture!();
    const [Foo, Bar] = captured as [new () => any, new () => any];
    const foo = new Foo();
    const bar = new Bar();
    foo.state = "host-only";
    bar.state = "updated";
    expect(foo.read()).toBe("keep");
    expect(foo.state).toBe("host-only");
    expect(bar.read()).toBe("updated");
  });

  it("keeps static methods on their own same-named class declaration", async () => {
    const captured: unknown[] = [];
    (globalThis as Record<string, unknown>).__grab4618static = (value: unknown) => {
      captured.push(value);
    };
    const result = await compile(
      `
      function Component(this: any, props: any): any { (this as any).props = props; }
      Component.prototype.isReactComponent = {};
      const React: any = { Component };
      export function a(): any {
        class Foo extends React.Component {
          static derive(props: any, state: any): any { return { foo: props.foo, bar: state.bar }; }
        }
        (globalThis as any).__grab4618static(Foo);
        return 1;
      }
      export function b(): any {
        class Foo extends React.Component {
          static derive(props: any, state: any): any { return "other"; }
        }
        (globalThis as any).__grab4618static(Foo);
        return 1;
      }`,
      { testRuntime: true, fileName: "issue-4618-static-tag-dispatch.ts", skipSemanticDiagnostics: true },
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
    const [First, Second] = captured as Array<{ derive(props: any, state: any): unknown }>;
    expect(First!.derive({ foo: "next" }, { bar: "prev" })).toEqual({ foo: "next", bar: "prev" });
    expect(Second!.derive({ foo: "next" }, { bar: "prev" })).toBe("other");
  });
});
