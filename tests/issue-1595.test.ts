// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, exportName = "test"): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports[exportName] as () => number)();
}

describe("#1595 ArrayBuffer transfer operations (standalone)", () => {
  it("transfers bytes into a grown fixed buffer and detaches the source", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const source = new ArrayBuffer(4);
          const sourceBytes = new Uint8Array(source);
          sourceBytes[0] = 1;
          sourceBytes[1] = 2;
          sourceBytes[2] = 3;
          sourceBytes[3] = 4;

          const dest = source.transfer(5);
          const destBytes = new Uint8Array(dest);
          let detachedSlice = 0;
          try { source.slice(); }
          catch (error) { detachedSlice = error instanceof TypeError ? 1 : 9; }

          return source.byteLength * 1000000
            + dest.byteLength * 100000
            + dest.maxByteLength * 10000
            + (dest.resizable ? 1000 : 0)
            + destBytes[0] * 100
            + destBytes[3] * 10
            + destBytes[4]
            + detachedSlice;
        }
      `),
    ).toBe(550141);
  });

  it("preserves a resizable buffer's maxByteLength for transfer", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const source = new ArrayBuffer(4, { maxByteLength: 8 });
          new Uint8Array(source)[0] = 7;
          const dest = source.transfer(5);
          return source.byteLength * 10000
            + dest.byteLength * 1000
            + dest.maxByteLength * 100
            + (dest.resizable ? 10 : 0)
            + new Uint8Array(dest)[0];
        }
      `),
    ).toBe(5817);
  });

  it("transferToFixedLength drops resizability and can outgrow the old maximum", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const source = new ArrayBuffer(2, { maxByteLength: 4 });
          new Uint8Array(source)[0] = 6;
          const dest = source.transferToFixedLength(5);
          return source.byteLength * 10000
            + dest.byteLength * 1000
            + dest.maxByteLength * 100
            + (dest.resizable ? 10 : 0)
            + new Uint8Array(dest)[0];
        }
      `),
    ).toBe(5506);
  });

  it("distinguishes null from omitted and undefined lengths on direct and reflective calls", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const directNull = new ArrayBuffer(4).transfer(null as any);
          const directUndefined = new ArrayBuffer(3).transfer(undefined);
          const reflectiveNull = ArrayBuffer.prototype.transfer.call(new ArrayBuffer(2), null as any);
          const reflectiveOmitted = ArrayBuffer.prototype.transfer.call(new ArrayBuffer(5));
          return directNull.byteLength * 1000
            + directUndefined.byteLength * 100
            + reflectiveNull.byteLength * 10
            + reflectiveOmitted.byteLength;
        }
      `),
    ).toBe(305);
  });

  it("shares the native operation with reflective prototype calls and brand checks", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const source = new ArrayBuffer(4);
          new Uint8Array(source)[0] = 9;
          const dest = ArrayBuffer.prototype.transfer.call(source, 3);
          let wrongReceiver = 0;
          try { ArrayBuffer.prototype.transfer.call({}); }
          catch (error) { wrongReceiver = error instanceof TypeError ? 1 : 9; }
          return source.byteLength * 1000
            + dest.byteLength * 10
            + new Uint8Array(dest)[0]
            + wrongReceiver;
        }
      `),
    ).toBe(40);
  });

  it("throws real JS error objects for detached operations and excessive lengths", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const source = new ArrayBuffer(4, { maxByteLength: 8 });
          source.transfer(3);
          let result = 0;
          try { source.resize(1); }
          catch (error) { if (error instanceof TypeError) result += 1; }
          try { source.slice(); }
          catch (error) { if (error instanceof TypeError) result += 2; }
          try { source.transferToFixedLength(); }
          catch (error) { if (error instanceof TypeError) result += 4; }
          try { new ArrayBuffer(0).transfer(9007199254740992); }
          catch (error) { if (error instanceof RangeError) result += 8; }
          return result;
        }
      `),
    ).toBe(15);
  });

  it("runs ToPrimitive(number) once and propagates its TypeError", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          let log = 0;
          const newLength: any = {
            valueOf() { log = log * 10 + 1; return {}; },
            toString() { log = log * 10 + 2; return {}; }
          };
          try { new ArrayBuffer(0).transfer(newLength); return 0; }
          catch (error) { return log * 10 + (error instanceof TypeError ? 1 : 2); }
        }
      `),
    ).toBe(121);
  });
});
