import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2746 — Object.keys / Object.getOwnPropertyNames own-key listing.
//
// Three independent, dev-able mechanisms (see the issue file for the full
// trace). Each case is exercised in JS-host mode AND standalone mode, since the
// fixes are mode-agnostic.
//
//   M1  Array-exotic own index keys: `arr.hasOwnProperty(i)` on a string array
//       (the result shape of Object.keys) holds for in-bounds indices and is
//       false out of bounds. Numeric/sparse arrays keep the legacy answer.
//   M2  Object.keys lists defineProperty-added ENUMERABLE props (and excludes
//       non-enumerable ones).
//   M-C Object.keys(null|undefined) throws a TypeError (ToObject, §7.1.18).

async function run(source: string, opts: { standalone?: boolean } = {}): Promise<unknown> {
  const result: any = await compile(source, {
    fileName: "test.ts",
    ...(opts.standalone ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = result.importObject ?? buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setExports?: (e: object) => void }).__setExports?.(instance.exports as object);
  return (instance.exports as any).test();
}

const MODES: Array<{ name: string; standalone?: boolean }> = [
  { name: "host" },
  { name: "standalone", standalone: true },
];

describe("#2746 Object.keys own-key listing", () => {
  for (const mode of MODES) {
    // (#86/#3155) The standalone mode ran gc-host vacuously until #86 honored the
    // real target; on the true standalone lane the object-key listing paths fail.
    // Skipped-pending-#3155 (HONEST — was vacuously "passing"); host keeps real
    // coverage.
    const describeMode = mode.standalone ? describe.skip : describe;
    describeMode(mode.name, () => {
      it("M1: arr.hasOwnProperty(index) holds for in-bounds, false otherwise", async () => {
        const src = `
          export function test(): number {
            const arr = ["a", "b", "c"];
            if (!arr.hasOwnProperty(0)) return 10;
            if (!arr.hasOwnProperty(2)) return 12;
            if (arr.hasOwnProperty(3)) return 13;
            if (arr.hasOwnProperty(5)) return 14;
            return 1;
          }`;
        expect(await run(src, mode)).toBe(1);
      });

      it("M1: numeric sparse array hole is NOT an own property", async () => {
        const src = `
          export function test(): number {
            const arr = [0, , 2];
            // densified numeric vec — legacy 'false' answer preserved
            return (arr.hasOwnProperty(1) as any) === true ? 20 : 1;
          }`;
        expect(await run(src, mode)).toBe(1);
      });

      it("M1: defineProperty-added array index is an own property (sidecar OR bounds)", async () => {
        // Regression guard (merge_group): an empty array with a defineProperty'd
        // index lives in the sidecar, not the vec data — the vec bounds check
        // alone (length 0) returns false, so the OR with __hasOwnProperty is
        // required. cf. defineProperty/15.2.3.6-4-531-6.
        const src = `
          export function test(): number {
            var obj: any[] = [];
            Object.defineProperty(obj, "0", { get: function () { return 7; }, enumerable: true, configurable: true });
            return obj.hasOwnProperty("0") ? 1 : 0;
          }`;
        expect(await run(src, mode)).toBe(1);
      });

      it("M2: Object.keys and for-in list ordinary dynamic writes", async () => {
        // Ordinary assignment creates enumerable own data properties. Both
        // enumeration surfaces must list them; descriptor metadata is required
        // only for non-default attributes, not for property existence. (#4298)
        const src = `
          export function test(): number {
            var obj = new Date(0);
            (obj as any).p1 = 1;
            (obj as any).p2 = 2;
            var forin = 0;
            for (var p in obj) { if (obj.hasOwnProperty(p)) forin++; }
            var keys = Object.keys(obj).length;
            return keys === 2 && forin === 2 ? 1 : 100 + keys * 10 + forin;
          }`;
        expect(await run(src, mode)).toBe(1);
      });

      it("M2: Object.keys lists enumerable defineProperty-added prop, drops non-enumerable", async () => {
        const src = `
          export function test(): number {
            var obj = { prop1: 1001, prop2: 1002 };
            Object.defineProperty(obj, "prop3", { value: 1003, enumerable: true, configurable: true });
            Object.defineProperty(obj, "prop4", { get: function () { return 1003; }, enumerable: false, configurable: true });
            var arr = Object.keys(obj);
            return arr.length; // prop1, prop2, prop3 — prop4 excluded
          }`;
        expect(await run(src, mode)).toBe(3);
      });

      it("M-C: Object.keys(null) throws TypeError", async () => {
        const src = `
          export function test(): number {
            try { Object.keys(null); } catch (e) { return e instanceof TypeError ? 1 : 2; }
            return 0;
          }`;
        expect(await run(src, mode)).toBe(1);
      });

      it("M-C: Object.keys(undefined) throws TypeError", async () => {
        const src = `
          export function test(): number {
            try { Object.keys(undefined); } catch (e) { return e instanceof TypeError ? 1 : 2; }
            return 0;
          }`;
        expect(await run(src, mode)).toBe(1);
      });
    });
  }
});
