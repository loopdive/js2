// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: a host-instantiated dynamic-parent class must read instance props
// through the host sidecar when a structurally identical sibling class exists.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

describe("#4618 host-instantiated class props sidecar", () => {
  it("keeps host-written props visible through methods and lifecycle state", async () => {
    let CompiledClass: any;
    const captureName = "__capturePropsSidecarClass4618";
    const previousCapture = (globalThis as Record<string, unknown>)[captureName];
    (globalThis as Record<string, unknown>)[captureName] = (value: unknown) => {
      CompiledClass = value;
    };

    try {
      const result = await compile(
        `
          function Base(this: any, _props: any) {}
          Base.prototype.isReactComponent = {};
          const React: any = { Component: Base };

          // Same field-kind layout as Test, but a different nominal class. The
          // WasmGC canonical type therefore makes a bare ref.test on Sibling
          // match Test instances too; Sibling.props is the wrong physical slot.
          class Sibling {
            props: any = { value: "wrong" };
            extra: any = null;
          }

          let captured: any;
          export function make(): number {
            class Test extends React.Component {
              own: any = null;
              other: any = null;
              render(): string { return String((this as any).props.value); }
              componentDidMount(): void { captured = this; }
            }
            (globalThis as any).__capturePropsSidecarClass4618(Test);
            return 1;
          }
          export function read(): string { return String(captured.props.value); }
        `,
        {
          fileName: "issue-4618-host-class-props-sidecar.ts",
          skipSemanticDiagnostics: true,
          testRuntime: true,
        },
      );
      expect(result.success).toBe(true);

      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary!, imports);
      (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, () => unknown>;
      exports.make();

      expect(typeof CompiledClass).toBe("function");
      const value = new CompiledClass({ value: "host" });
      // ReactDOM writes this after construction through the host wrapper. This
      // must remain a sidecar-only value because Test declares no props field.
      value.props = { value: "host" };
      expect(value.render()).toBe("host");

      // Exercise the same instance through a compiled lifecycle body and then
      // a second compiled read from the captured `this` value.
      value.componentDidMount();
      expect(exports.read()).toBe("host");
    } finally {
      if (previousCapture === undefined) delete (globalThis as Record<string, unknown>)[captureName];
      else (globalThis as Record<string, unknown>)[captureName] = previousCapture;
    }
  });
});
