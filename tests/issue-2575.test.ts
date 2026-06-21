// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2575 — `for (k in arr)` must enumerate the array's own enumerable property
 * keys: the integer-index keys `"0".."length-1"` (as strings), ascending
 * (§13.7.5 / OrdinaryOwnPropertyKeys). Previously an array receiver routed to
 * the for-in static-unroll fallback, which enumerated the array TYPE's
 * `getProperties()` (`length` + Array.prototype members) under standalone (wrong
 * count), and enumerated nothing under JS-host mode (count 0).
 *
 * The fix emits a self-contained native index loop (`emitArrayForIn`) for BOTH
 * modes: length from the vec struct (field 0), each index ToString'd via
 * `number_toString` (native under standalone via `emitNativeNumberFormat`, host
 * import under GC). No `__for_in_*` host import and no `$ObjVec` walk.
 */

async function run(src: string, target: "gc" | "standalone"): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test?: () => number }).test?.();
}

const targets: Array<"gc" | "standalone"> = ["gc", "standalone"];

describe("#2575 — for-in over an array enumerates numeric indices", () => {
  for (const target of targets) {
    describe(`target: ${target}`, () => {
      it("counts one iteration per index", async () => {
        expect(
          await run(
            `export function test(): number { const a=[10,20,30]; let n=0; for (const k in a) n++; return n; }`,
            target,
          ),
        ).toBe(3);
      });

      it("yields the keys '0','1','2' as strings in ascending order", async () => {
        // key-string compare avoids host string methods; weights pin the order.
        const v = await run(
          `export function test(): number {
             const a=[10,20,30]; let s=0;
             for (const k in a) {
               if (k==="0") s+=100; else if (k==="1") s+=10; else if (k==="2") s+=1; else s+=1000;
             }
             return s;
           }`,
          target,
        );
        expect(v).toBe(111);
      });

      it("enumerates empty arrays zero times", async () => {
        expect(
          await run(
            `export function test(): number { const a: number[]=[]; let n=0; for (const k in a) n++; return n; }`,
            target,
          ),
        ).toBe(0);
      });

      it("honors break", async () => {
        expect(
          await run(
            `export function test(): number { const a=[10,20,30,40]; let n=0; let i=0; for (const k in a) { if (i===2) break; n++; i++; } return n; }`,
            target,
          ),
        ).toBe(2);
      });

      it("honors continue", async () => {
        expect(
          await run(
            `export function test(): number { const a=[10,20,30,40]; let n=0; let i=0; for (const k in a) { i++; if (i===2) continue; n++; } return n; }`,
            target,
          ),
        ).toBe(3);
      });

      it("nests correctly", async () => {
        expect(
          await run(
            `export function test(): number { const a=[1,2]; const b=[1,2,3]; let n=0; for (const i in a) for (const j in b) n++; return n; }`,
            target,
          ),
        ).toBe(6);
      });

      it("works with a string array (element type is independent of the key set)", async () => {
        expect(
          await run(
            `export function test(): number { const a=["x","y","z","w"]; let n=0; for (const k in a) n++; return n; }`,
            target,
          ),
        ).toBe(4);
      });

      it("works with a var head", async () => {
        expect(
          await run(
            `export function test(): number { const a=[1,2,3]; let n=0; for (var k in a) n++; return n; }`,
            target,
          ),
        ).toBe(3);
      });
    });
  }

  it("standalone leaks no env::number_toString host import", async () => {
    const r = await compile(
      `export function test(): number { const a=[10,20,30]; let n=0; for (const k in a) n++; return n; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success).toBe(true);
    const hostImports = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(hostImports.some((l) => l === "env::number_toString")).toBe(false);
    // No `__for_in_*` host import either (the native index loop replaces it).
    expect(hostImports.some((l) => l.startsWith("env::__for_in_"))).toBe(false);
  });
});
