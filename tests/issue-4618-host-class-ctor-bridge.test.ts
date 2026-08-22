// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: host-instantiates-compiled-class (the react class-component seam).
// Three coordinated fixes:
//  1. `__register_class_ctor` — the class-object singleton init registers the
//     compiled `<Class>_new` ctor closure + prototype + name; `_wrapForHost`
//     presents a registered class object as a CONSTRUCTIBLE function mirror
//     (react-dom's `new type(props, context)`), tagging instances so
//     host-side `instance.render()` dispatches via the #3123 member surface.
//  2. `__register_class_parent` — a dynamic `extends <value>` parent
//     (react's `class Foo extends React.Component`, unresolvable statically)
//     is evaluated at the DECLARATION statement and registered by name, so
//     `Foo.prototype.isReactComponent` chains through the live parent's
//     vivified prototype (react-dom's shouldConstruct detection).
//  3. Top-level `F.prototype.m = …` statements were silently DROPPED from
//     `__module_init` in host mode (the #2671 keep-arm excluded prototype
//     chains) — react's whole `Component.prototype.*` surface is exactly such
//     top-level writes. Same collection-gap family as #2992/#3592/#3615.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function runAndGrab(source: string): Promise<any> {
  let captured: unknown = null;
  (globalThis as Record<string, unknown>).__grab4618t = (v: unknown) => {
    captured = v;
  };
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-class-bridge.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exp = wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
  (exp.send as () => unknown)();
  return captured;
}

describe("#4618 host-side [[Construct]] on compiled classes", () => {
  it("top-level F.prototype.m = … writes execute at module init", async () => {
    const Foo = await runAndGrab(`
      function Base(this: any) {}
      Base.prototype.mark = 42;
      export function send(): any { (globalThis as any).__grab4618t((Base as any).prototype); return 1; }`);
    expect((Foo as Record<string, unknown>).mark).toBe(42);
  });

  it("react shape: dynamic-parent class is constructible with chained detection marker", async () => {
    const Foo: any = await runAndGrab(`
      function Base(this: any, props: any) { (this as any).props = props; }
      Base.prototype.isReactComponent = {};
      const NS: any = { Component: Base };
      export function send(): any {
        class Foo extends NS.Component {
          marker: string;
          constructor(props: any) { super(props); this.marker = "made"; }
          render(): any { return "rendered:" + String((this as any).marker); }
        }
        (globalThis as any).__grab4618t(Foo);
        return 1;
      }`);
    // shouldConstruct: typeof function + prototype.isReactComponent truthy
    expect(typeof Foo).toBe("function");
    expect(Foo.prototype.isReactComponent != null).toBe(true);
    // [[Construct]] + instance method dispatch from the host side
    const inst = new Foo({ prop: "k" });
    expect(inst.marker).toBe("made");
    expect(typeof inst.render).toBe("function");
    expect(inst.render()).toBe("rendered:made");
  });
});
