// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4449 — standalone TypedArray prototype methods must validate their shared
// backing view before materialising it into a native vector.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4449.ts",
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#4449 — standalone TypedArray ValidateTypedArray", () => {
  it("throws TypeError for detached views before map callback execution", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const view = new Uint16Array(buffer);
          buffer.transfer();
          let callbackCalls = 0;
          try {
            view.map((value) => { callbackCalls++; return value; });
            return 0;
          } catch (error) {
            return error instanceof TypeError && callbackCalls === 0 ? 1 : 2;
          }
        }
      `),
    ).toBe(1);
  });

  it("throws TypeError for detached views before scalar HOF callbacks", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const view = new Uint16Array(buffer);
          buffer.transfer();
          let callbackCalls = 0;
          try {
            view.reduce((left, right) => { callbackCalls++; return left + right; }, 0);
            return 0;
          } catch (error) {
            return error instanceof TypeError && callbackCalls === 0 ? 1 : 2;
          }
        }
      `),
    ).toBe(1);
  });

  it("throws TypeError for a fixed view that is out of bounds after resize", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
          const view = new Uint16Array(buffer, 4, 2);
          buffer.resize(4);
          try {
            view.fill(7);
            return 0;
          } catch (error) {
            return error instanceof TypeError ? 1 : 2;
          }
        }
      `),
    ).toBe(1);
  });

  it("keeps in-bounds shared views usable after an unrelated resize", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
          const view = new Uint16Array(buffer, 0, 2);
          buffer.resize(8);
          view.fill(3);
          return view[0] === 3 && view[1] === 3 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
