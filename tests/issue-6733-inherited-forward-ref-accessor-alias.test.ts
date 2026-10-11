// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6733 — an inherited class member whose signature names a class declared
// LATER in the source is typed twice: at collection the forward class resolves
// to externref, and class-body compilation re-resolves it to the struct ref.
// A child class aliases the parent member in between, so its Program-ABI alias
// carried the provisional signature and retained planning threw
// `alias-signature-mismatch` (three.js: `RenderTarget.depthTexture` getter,
// `@type {?DepthTexture}`, inherited by `WebGLRenderTarget`).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, fileName: string): Promise<number> {
  const r = await compile(source, { fileName, target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const instance = await WebAssembly.instantiate(mod, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6733 inherited member alias follows a forward-reference re-type", () => {
  it("getter, setter and methods naming a later class, inherited by child and grandchild (TS)", async () => {
    const value = await runStandalone(
      `
      class Base {
        _d: Later | null = null;
        get d(): Later | null { return this._d; }
        set d(v: Later | null) { this._d = v; }
        make(): Later { return new Later(7); }
        take(x: Later): number { return x.v; }
      }
      class Child extends Base {}
      class Grand extends Child {}
      class Later {
        v: number;
        constructor(v: number) { this.v = v; }
      }
      export function test(): number {
        const g = new Grand();
        g.d = new Later(3);
        const c = new Child();
        const got = g.d;
        return (got !== null ? got.v : 0) + (c.d === null ? 10 : 0) + c.make().v * 100 + g.take(new Later(4)) * 1000;
      }
      `,
      "issue-6733.ts",
    );
    expect(value).toBe(4713);
  });

  it("three.js RenderTarget.depthTexture shape: JSDoc getter typed by a later class (JS)", async () => {
    const value = await runStandalone(
      `
      class Texture {
        constructor() { this.renderTarget = null; }
      }
      class RenderTarget {
        constructor(options = {}) {
          options = Object.assign({ depthTexture: null }, options);
          this._depthTexture = null;
          this.depthTexture = options.depthTexture;
        }
        set depthTexture(current) {
          if (current !== null) current.renderTarget = this;
          this._depthTexture = current;
        }
        /** @type {?DepthTexture} */
        get depthTexture() {
          return this._depthTexture;
        }
      }
      class WebGLRenderTarget extends RenderTarget {
        constructor(options = {}) {
          super(options);
          this.isWebGLRenderTarget = true;
        }
      }
      class DepthTexture extends Texture {
        constructor() {
          super();
          this.isDepthTexture = true;
        }
      }
      /** @returns {number} */
      export function test() {
        const t = new WebGLRenderTarget({ depthTexture: new DepthTexture() });
        const r = new RenderTarget();
        return (t.depthTexture !== null ? 1 : 0) + (r.depthTexture === null ? 10 : 0);
      }
      `,
      "issue-6733.js",
    );
    expect(value).toBe(11);
  });
});
