// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

describe("native buffer/view brands across compileMulti", () => {
  it("creates an early Uint8Array byte window over a later registered DataView", async () => {
    const result = await compileMulti(
      {
        "./window.ts": `
          export function dataViewByteWindow(view: DataView): Uint8Array {
            return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          }

          export function encodeDataView(value: any): number {
            const elements: Uint8Array = dataViewByteWindow(value as DataView);
            if (elements.byteLength !== 3) return 200 + elements.byteLength;
            elements[1] = 9;
            return 77;
          }
        `,
        "./factory.ts": `
          import { encodeDataView } from "./window.ts";

          let registry: any[] = [undefined];

          function hostDataView(buffer: any, byteOffset: number, byteLength: number): any {
            return new DataView(buffer, byteOffset, byteLength);
          }

          export function probe(): number {
            registry = [undefined];
            const buffer: any = new ArrayBuffer(6);
            const view: any = hostDataView(buffer, 2, 3);
            view.setUint8(0, 4);
            view.setUint8(1, 5);
            view.setUint8(2, 6);
            registry.push(view);
            const encoded = encodeDataView(registry[1]);
            if (encoded !== 77) return encoded;
            if (view.getUint8(1) !== 9) return 300;
            return 77;
          }
        `,
        "./entry.ts": `
          import { probe } from "./factory.ts";
          export function test(): number { return probe(); }
        `,
      },
      "./entry.ts",
      {
        target: "standalone",
        platform: "deno",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(77);
  });

  it("does not classify a source-defined DataView name as a native backing view", async () => {
    const result = await compileMulti(
      {
        "./shadow.ts": `
          interface DataView {
            buffer: number;
            byteOffset: number;
            byteLength: number;
          }

          function byteWindow(view: DataView): Uint8Array {
            return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          }

          export function test(): number {
            return byteWindow({ buffer: 3, byteOffset: 0, byteLength: 1 }).byteLength;
          }
        `,
      },
      "./shadow.ts",
      {
        target: "standalone",
        platform: "deno",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(0);
  });

  it("writes a packed TypedArray recovered from a reassigned global transaction table", async () => {
    const result = await compileMulti(
      {
        "./mutation.ts": `
          function decode(value: any[]): any {
            if (value[0] === "d") return value[1];
            return undefined;
          }

          export function applyMutation(targets: any[], id: number): number {
            const target: any = targets[id];
            const elements: any[] = JSON.parse('[["d",9],["d",8],["d",7]]');
            for (let index = 0; index < elements.length; index++) {
              target[index] = decode(elements[index]);
            }
            return target[0];
          }
        `,
        "./factory.ts": `
          import { applyMutation } from "./mutation.ts";

          let targets: any[] = [undefined];

          export function probe(): number {
            targets = [undefined];
            const viewBuffer: any = new ArrayBuffer(1);
            const viewDemand = new Uint8Array(viewBuffer, 0, 1);
            viewDemand[0] = 6;
            const bytes = new Uint8Array([1, 2, 3]);
            targets.push(bytes);
            if (targets[1] !== bytes) return 10;
            const dynamicAfter = applyMutation(targets, 1);
            if (dynamicAfter !== 9) return 100 + dynamicAfter;
            if (bytes[0] !== 9) return 1;
            if (bytes[1] !== 8) return 2;
            if (bytes[2] !== 7) return 3;
            return 76;
          }
        `,
        "./entry.ts": `
          import { probe } from "./factory.ts";
          export function test(): number { return probe(); }
        `,
      },
      "./entry.ts",
      {
        target: "standalone",
        platform: "deno",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(76);
  });

  it("writes a later buffer-backed TypedArray through an earlier any helper", async () => {
    const result = await compileMulti(
      {
        "./mutation.ts": `
          function decode(value: any[]): any {
            if (value[0] === "d") return value[1];
            return undefined;
          }

          export function applyMutation(targets: any[], id: number): void {
            const target: any = targets[id];
            const elements: any[] = JSON.parse('[["d",9],["d",8],["d",7]]');
            for (let index = 0; index < elements.length; index++) {
              target[index] = decode(elements[index]);
            }
          }
        `,
        "./factory.ts": `
          import { applyMutation } from "./mutation.ts";

          export function probe(): number {
            const buffer: any = new ArrayBuffer(3);
            const view = new Uint8Array(buffer, 0, 3);
            const opaqueView: any = view;
            const targets: any[] = [undefined, opaqueView];
            if (targets[1] !== opaqueView) return 10;
            applyMutation(targets, 1);
            if (view[0] !== 9) return 1;
            if (view[1] !== 8) return 2;
            if (view[2] !== 7) return 3;
            return 75;
          }
        `,
        "./entry.ts": `
          import { probe } from "./factory.ts";
          export function test(): number { return probe(); }
        `,
      },
      "./entry.ts",
      {
        target: "standalone",
        platform: "deno",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(75);
  });

  it("classifies a dynamically constructed TypedArray in a later source file", async () => {
    const result = await compileMulti(
      {
        "./tagger.ts": `
          export function nativeTag(value: any): string {
            return Object.prototype.toString.call(value);
          }
        `,
        "./factory.ts": `
          import { nativeTag } from "./tagger.ts";

          export function probe(): number {
            const constructors: any[] = [Int16Array];
            let tag = "";
            for (const Constructor of constructors) {
              const buffer = new ArrayBuffer(8);
              const view: any = new Constructor(buffer);
              tag = nativeTag(view);
            }
            if (tag === "[object Int16Array]") return 71;
            if (tag === "[object Array]") return 12;
            if (tag === "[object Object]") return 13;
            return 1;
          }
        `,
        "./entry.ts": `
          import { probe } from "./factory.ts";
          export function test(): number { return probe(); }
        `,
      },
      "./entry.ts",
      {
        target: "standalone",
        platform: "deno",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(71);
  });
});
