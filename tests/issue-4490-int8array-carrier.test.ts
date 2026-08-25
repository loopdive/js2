// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4490 wave 2) Int8Array is the first TypedArray constructor moved from the
// synthetic `$__ta_ctor` value to one mutable `$Object` carrier.  These probes
// deliberately pass the constructor through `any`, which keeps the checks on
// the runtime reflection paths used by propertyHelper.js instead of the
// compiler's literal-receiver folds.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4490-int8array.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, (result.errors ?? []).map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports.filter((i) => i.module === "env")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4490 wave 2 — Int8Array's own-property carrier coherence", () => {
  it("keeps dynamic read, in, hasOwnProperty, gOPD, and delete on one state", async () => {
    expect(
      await runStandalone(`
        function gopd(o: any, key: any): any { return Object.getOwnPropertyDescriptor(o, key); }
        function own(o: any, key: any): number { return o.hasOwnProperty(key) ? 1 : 0; }
        export function test(): number {
          const C: any = Int8Array;
          const d: any = gopd(C, "length");
          const before = d !== undefined && d.value === 3 && d.writable === false &&
            d.enumerable === false && d.configurable === true &&
            own(C, "length") === 1 && ("length" in C) ? 1 : 0;
          const deleted = delete C.length ? 1 : 0;
          const after = gopd(C, "length") === undefined && own(C, "length") === 0 &&
            !("length" in C) ? 1 : 0;
          return before + deleted + after === 3 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("seeds the migrated ctor's non-configurable BYTES_PER_ELEMENT entry", async () => {
    expect(
      await runStandalone(`
        function gopd(o: any, key: any): any { return Object.getOwnPropertyDescriptor(o, key); }
        function own(o: any, key: any): number { return o.hasOwnProperty(key) ? 1 : 0; }
        export function test(): number {
          const C: any = Int8Array;
          const d: any = gopd(C, "BYTES_PER_ELEMENT");
          const coherent = d !== undefined && d.value === 1 && d.writable === false &&
            d.enumerable === false && d.configurable === false && own(C, "BYTES_PER_ELEMENT") === 1 &&
            ("BYTES_PER_ELEMENT" in C) && C.BYTES_PER_ELEMENT === 1;
          const refused = Reflect.deleteProperty(C, "BYTES_PER_ELEMENT") === false &&
            gopd(C, "BYTES_PER_ELEMENT") !== undefined;
          return coherent && refused ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("preserves dynamic construction and instance-to-constructor identity", async () => {
    expect(
      await runStandalone(`
        function make(C: any): any { return new C([4, 5]); }
        export function test(): number {
          const view: any = make(Int8Array);
          const C: any = view.constructor;
          return view.length === 2 && view[0] === 4 && view[1] === 5 &&
            C === Int8Array && C.name === "Int8Array" && C.length === 3 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps inherited TypedArray statics on the migrated carrier", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const C: any = Int8Array;
          const from: any = C.from([3, 4]);
          const of: any = C.of(5, 6);
          return from.length === 2 && from[0] === 3 && from[1] === 4 &&
            of.length === 2 && of[0] === 5 && of[1] === 6 &&
            from.constructor === C && of.constructor === C ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("throws when the migrated constructor is called without new", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const C: any = Int8Array;
          try {
            C();
            return 0;
          } catch (error) {
            return error instanceof TypeError ? 1 : 0;
          }
        }
      `),
    ).toBe(1);
  });
});
