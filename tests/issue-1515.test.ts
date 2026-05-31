// #1515: DataView ToIndex / detached buffer / BigInt setters
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { compileAndInstantiate } from "../src/runtime.ts";

async function runSource(src: string): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("Compile error: " + r.errors[0]?.message);
  const exports = await compileAndInstantiate(src);
  return (exports.test as any)?.();
}

describe("#1515 DataView spec fidelity", () => {
  it("ToIndex(byteOffset): 1.5 is truncated to 1, no RangeError", async () => {
    const src = `
      function test(): number {
        try {
          const buf = new ArrayBuffer(16);
          const dv = new DataView(buf, 1.5);
          return 1;
        } catch (e) { return 0; }
      }
      export { test };
    `;
    expect(await runSource(src)).toBe(1);
  });

  it("ToIndex(byteOffset): NaN becomes 0 (no RangeError)", async () => {
    const src = `
      function test(): number {
        try {
          const buf = new ArrayBuffer(16);
          const dv = new DataView(buf, NaN);
          return 1;
        } catch (e) { return 0; }
      }
      export { test };
    `;
    expect(await runSource(src)).toBe(1);
  });

  it("ToIndex(byteOffset): undefined becomes 0 (no RangeError)", async () => {
    const src = `
      function test(): number {
        try {
          const buf = new ArrayBuffer(16);
          const dv = new DataView(buf, undefined);
          return 1;
        } catch (e) { return 0; }
      }
      export { test };
    `;
    expect(await runSource(src)).toBe(1);
  });

  it("ToIndex(byteOffset): -1 still throws RangeError", async () => {
    const src = `
      function test(): number {
        try {
          const buf = new ArrayBuffer(16);
          new DataView(buf, -1);
          return 0;
        } catch (e) { return 1; }
      }
      export { test };
    `;
    expect(await runSource(src)).toBe(1);
  });

  it("setBigInt64 with BigInt round-trips", async () => {
    const src = `
      function test(): number {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setBigInt64(0, -1n);
        return dv.getBigInt64(0) === -1n ? 1 : 0;
      }
      export { test };
    `;
    expect(await runSource(src)).toBe(1);
  });

  it("DataView setter returns undefined", async () => {
    const src = `
      function test(): number {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        const r: any = dv.setUint8(0, 1);
        return r === undefined ? 1 : 0;
      }
      export { test };
    `;
    expect(await runSource(src)).toBe(1);
  });

  it("Detached buffer throws TypeError on getInt32", async () => {
    const src = `
      function test(): number {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf, 0);
        (buf as any).__detached__ = true;
        try {
          dv.getInt32(0);
          return 0;
        } catch (e: any) { return 1; }
      }
      export { test };
    `;
    expect(await runSource(src)).toBe(1);
  });

  it("Detached buffer throws TypeError on setUint32", async () => {
    const src = `
      function test(): number {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf, 0);
        (buf as any).__detached__ = true;
        try {
          dv.setUint32(0, 42);
          return 0;
        } catch (e: any) { return 1; }
      }
      export { test };
    `;
    expect(await runSource(src)).toBe(1);
  });
});
