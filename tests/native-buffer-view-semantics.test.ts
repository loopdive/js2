// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "native-buffer-view-semantics.ts",
    target: "wasi",
  });
  expect(result.success, result.success ? "" : result.errors?.map((error) => error.message).join("\n")).toBe(true);
  if (process.env.DEBUG_NATIVE_VIEW_WAT === "1") {
    const lines = result.wat.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]?.includes("(func $test")) {
        console.error(lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 800)).join("\n"));
      }
    }
  }
  const module = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("native ArrayBuffer view semantics", () => {
  it("recovers exact ArrayBuffer, DataView, and TypedArray brands through any", async () => {
    expect(
      await runStandalone(`
        function tag(value: any): string {
          try {
            return Object.prototype.toString.call(value);
          } catch (_error) {
            return "";
          }
        }
        export function test(): number {
          const buffer: any = new ArrayBuffer(8);
          const dataView: any = new DataView(buffer);
          const uint8: any = new Uint8Array(buffer);
          const int16: any = new Int16Array(buffer);
          const values: any[] = [buffer, dataView, uint8, int16];
          const bufferTag = tag(values[0]);
          if (bufferTag !== "[object ArrayBuffer]") {
            if (bufferTag === "") return 11;
            if (bufferTag === "[object Array]") return 12;
            if (bufferTag === "[object Object]") return 13;
            return 1;
          }
          if (tag(values[1]) !== "[object DataView]") return 2;
          if (tag(values[2]) !== "[object Uint8Array]") return 3;
          if (tag(values[3]) !== "[object Int16Array]") return 4;
          return 71;
        }
      `),
    ).toBe(71);
  });

  it("keeps subarray on the same buffer with an accumulated byte offset", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const source = new Uint16Array(buffer, 2, 3);
          source[0] = 1;
          source[1] = 2;
          source[2] = 3;
          const alias = source.subarray(1, 3);
          if (alias.length !== 2) return 1;
          if (alias.byteOffset !== 4) return 2;
          if (alias.buffer !== buffer) return 3;
          alias[0] = 9;
          if (source[1] !== 9) return 4;
          source[2] = 8;
          if (alias[1] !== 8) return 5;
          return 72;
        }
      `),
    ).toBe(72);
  });

  it("makes existing TypedArray views empty when their buffer is transferred", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const buffer = new ArrayBuffer(4);
          const source = new Uint8Array(buffer);
          const alias = new Uint8Array(buffer, 1, 2);
          const dataView = new DataView(buffer);
          source[1] = 9;
          if (alias[0] !== 9 || dataView.getUint8(1) !== 9) return 1;
          buffer.transfer(0);
          if (buffer.byteLength !== 0) return 2;
          if (source.length !== 0 || source.byteLength !== 0) return 3;
          if (alias.length !== 0 || alias.byteLength !== 0 || alias.byteOffset !== 0) return 4;
          try {
            dataView.byteLength;
            return 5;
          } catch (error) {
            if ((error as any).name !== "TypeError") return 6;
          }
          try {
            dataView.byteOffset;
            return 7;
          } catch (error) {
            if ((error as any).name !== "TypeError") return 8;
          }
          return 73;
        }
      `),
    ).toBe(73);
  });

  it("keeps inline TypedArray copy constructors stack-balanced in calls", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const receiver: any = {
            accept(_value: any): void {},
          };
          receiver.accept(new Uint8Array([1, 2]));
          return 74;
        }
      `),
    ).toBe(74);
  });

  it("mutates packed and buffer-backed TypedArrays recovered from an any-typed transaction table", async () => {
    expect(
      await runStandalone(`
        function applyMutation(targets: any[], id: number): void {
          const target: any = targets[id];
          const elements: any[] = [9, 8, 7];
          for (let index = 0; index < elements.length; index++) {
            target[index] = elements[index];
          }
        }
        export function test(): number {
          const bytes = new Uint8Array([1, 2, 3]);
          const buffer = new ArrayBuffer(3);
          const view = new Uint8Array(buffer, 0, 3);
          view[0] = 4;
          view[1] = 5;
          view[2] = 6;
          const opaqueView: any = view;
          const targets: any[] = [undefined, bytes, opaqueView];
          applyMutation(targets, 1);
          if (bytes[0] !== 9) return 1;
          if (bytes[1] !== 8) return 2;
          if (bytes[2] !== 7) return 3;
          applyMutation(targets, 2);
          if (view[0] !== 9) return 4;
          if (view[1] !== 8) return 5;
          if (view[2] !== 7) return 6;
          return 75;
        }
      `),
    ).toBe(75);
  });
});
