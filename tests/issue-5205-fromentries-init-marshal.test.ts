import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5205) `Object.fromEntries` over a COMPILED iterable — the sixth facet of
 * the #5193/#5202/#5203 module-init window, and the first one that is not
 * purely about timing.
 *
 * Two independent defects, both visible from the same call:
 *
 *  1. The host `Object.fromEntries` needs `@@iterator` on its argument
 *     (§7.4.4 GetIterator). An opaque WasmGC vec has none, so the handler —
 *     a one-liner that passed the compiled value straight through — threw
 *     "object is not iterable" for EVERY compiled source, at init and after.
 *  2. §7.1.19 AddEntriesFromIterable then reads `Get(entry, "0"/"1")` off each
 *     entry. A heterogeneous `[key, value]` pair is a TUPLE struct whose
 *     fields are `_0`/`_1`, read through `__struct_field_names` + `__sget_*` —
 *     exports, hence unreachable during the wasm `start` section. That decoded
 *     to `{ undefined: undefined }`: silently wrong data rather than a throw.
 *
 * Every case pairs an AT-INIT call with an after-init CONTROL, so a fix that
 * regressed into "fromEntries stopped working at all" cannot pass.
 *
 * Temporal's `Object.fromEntries(nt.map((e) => [e[0], e[1]]))` at module top
 * level is exactly the second shape (#4628).
 */
async function run(source: string): Promise<{ atInit: unknown; afterInit: unknown }> {
  const result = await compile(source, { fileName: "issue-5205.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const exports = instance.exports as Record<string, () => unknown>;
  return { atInit: exports.atInit(), afterInit: exports.test() };
}

describe("#5205 — Object.fromEntries over a compiled iterable", () => {
  it("builds the object from a compiled array of pairs at init", async () => {
    // The narrowest statement of defect 1: on base this threw
    // "object is not iterable" before `atInit` could ever be called.
    expect(
      await run(`
        const pairs: any[] = [["a", 1], ["b", 2]];
        const O: any = Object.fromEntries(pairs);
        export function atInit(): number { return O.a + O.b; }
        export function test(): number {
          const o: any = Object.fromEntries(pairs);
          return o.a + o.b;
        }
      `),
    ).toEqual({ atInit: 3, afterInit: 3 });
  });

  it("decodes heterogeneous tuple pairs at init", async () => {
    // Defect 2. A `[string, number]` pair is a tuple struct, not a vec; with
    // only the vec half fixed this produced `{ undefined: undefined }` and
    // both reads answered `undefined`.
    expect(
      await run(`
        const pairs: [string, number][] = [["a", 1], ["b", 2]];
        const O: any = Object.fromEntries(pairs);
        export function atInit(): string { return String(O.a) + "," + String(O.b); }
        export function test(): string {
          const o: any = Object.fromEntries(pairs);
          return String(o.a) + "," + String(o.b);
        }
      `),
    ).toEqual({ atInit: "1,2", afterInit: "1,2" });
  });

  it("handles the Temporal shape — fromEntries over a .map() result at init", async () => {
    // `rt = Object.fromEntries(nt.map((e) => [e[0], e[1]]))`, the statement the
    // @js-temporal/polyfill bundle stops at during module init (#4628).
    expect(
      await run(`
        const nt: any[] = [["years", "year", "date"], ["months", "month", "date"]];
        const O: any = Object.fromEntries(nt.map((e: any) => [e[0], e[1]]));
        export function atInit(): string { return String(O.years) + "," + String(O.months); }
        export function test(): string {
          const o: any = Object.fromEntries(nt.map((e: any) => [e[0], e[1]]));
          return String(o.years) + "," + String(o.months);
        }
      `),
    ).toEqual({ atInit: "year,month", afterInit: "year,month" });
  });

  it("keeps the destructuring-callback variant working at init", async () => {
    // The polyfill's second call, `ot = Object.fromEntries(nt.map(([e, t]) => [t, e]))`.
    expect(
      await run(`
        const nt: any[] = [["years", "year"], ["months", "month"]];
        const O: any = Object.fromEntries(nt.map(([e, t]: any) => [t, e]));
        export function atInit(): string { return String(O.year) + "," + String(O.month); }
        export function test(): string {
          const o: any = Object.fromEntries(nt.map(([e, t]: any) => [t, e]));
          return String(o.year) + "," + String(o.month);
        }
      `),
    ).toEqual({ atInit: "years,months", afterInit: "years,months" });
  });

  it("applies ToPropertyKey and keeps non-string value kinds at init", async () => {
    // The engine's own §7.1.19 semantics must still run: a numeric key is
    // stringified, and an array value stays readable through the boundary
    // (the decode is deliberately SHALLOW — values are not copied).
    expect(
      await run(`
        const pairs: any[] = [[1, "one"], ["k", true], ["n", null], ["arr", [7, 8]]];
        const O: any = Object.fromEntries(pairs);
        export function atInit(): string {
          return String(O[1]) + "|" + String(O.k) + "|" + String(O.n) + "|" + String(O.arr[1]);
        }
        export function test(): string {
          const o: any = Object.fromEntries(pairs);
          return String(o[1]) + "|" + String(o.k) + "|" + String(o.n) + "|" + String(o.arr[1]);
        }
      `),
    ).toEqual({ atInit: "one|true|null|8", afterInit: "one|true|null|8" });
  });

  it("keeps an empty compiled source producing an empty object at init", async () => {
    expect(
      await run(`
        const pairs: any[] = [];
        const O: any = Object.fromEntries(pairs);
        export function atInit(): number { return Object.keys(O).length; }
        export function test(): number { return Object.keys(Object.fromEntries([] as any[])).length; }
      `),
    ).toEqual({ atInit: 0, afterInit: 0 });
  });

  it("leaves a real host iterable (Map) on the native path at init", async () => {
    // The control for the `!_nativeIsArray(src)` early return: a Map already
    // has `@@iterator`, worked before this change, and must be untouched.
    expect(
      await run(`
        const m = new Map<string, number>([["a", 1], ["b", 2]]);
        const O: any = Object.fromEntries(m);
        export function atInit(): number { return O.a + O.b; }
        export function test(): number {
          const o: any = Object.fromEntries(m);
          return o.a + o.b;
        }
      `),
    ).toEqual({ atInit: 3, afterInit: 3 });
  });

  it("still throws a TypeError for a non-iterable argument", async () => {
    // Marshalling must not turn a spec throw into a silent empty object.
    expect(
      await run(`
        export function atInit(): string { return "-"; }
        export function test(): string {
          try {
            const o: any = Object.fromEntries(42 as any);
            return "no-throw";
          } catch (e) {
            return "threw";
          }
        }
      `),
    ).toEqual({ atInit: "-", afterInit: "threw" });
  });
});
