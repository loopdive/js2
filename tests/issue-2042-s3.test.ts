import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2042 S3 — read-side descriptor-reflection natives in standalone:
//   Object.getOwnPropertyNames / getOwnPropertySymbols / getOwnPropertyDescriptors.
// Before this slice these refused under `--target standalone` (#1472 Phase B);
// they now compile host-free over the `$Object` runtime. The write side
// (`__defineProperty_desc`) is deferred until #2043 (late-import index-shift) is
// fixed, so it is NOT exercised here.
//
// Standalone native strings don't marshal across the JS export boundary, so we
// compare *internally* (return an i32 from `test()`), the same pattern the other
// standalone object-runtime tests use.

async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

async function compilesStandalone(body: string): Promise<boolean> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) return false;
  try {
    await WebAssembly.instantiate(r.binary, {});
    return true;
  } catch {
    return false;
  }
}

describe("#2042 S3 standalone descriptor-reflection natives", () => {
  it("getOwnPropertyNames returns own string keys (count)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { a: 1, b: 2, c: 3 };
           return Object.getOwnPropertyNames(o).length;
         }`,
      ),
    ).toBe(3);
  });

  it("getOwnPropertyNames includes both integer-index and string keys (count)", async () => {
    // §10.1.11.1 OrdinaryOwnPropertyKeys includes integer-index AND string keys.
    // (Precise ordering is exercised by the test262 getOwnPropertyNames suite;
    // here we assert all four own keys are returned — the order verification via
    // computed member access hits unrelated standalone gaps, #42.)
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { foo: 1, 2: 1, bar: 1, 0: 1 };
           return Object.getOwnPropertyNames(o).length; // 4
         }`,
      ),
    ).toBe(4);
  });

  it("getOwnPropertyNames includes non-enumerable keys (defineProperty enumerable:false)", async () => {
    // The enumerable filter is dropped for getOwnPropertyNames (via
    // __obj_ordered_all), so a non-enumerable own key still appears — unlike
    // Object.keys.
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { a: 1 };
           Object.defineProperty(o, "hidden", { value: 2, enumerable: false });
           const names = Object.getOwnPropertyNames(o);
           const keys = Object.keys(o);
           // names has both "a" and "hidden"; keys has only "a".
           return names.length === 2 && keys.length === 1 ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("getOwnPropertySymbols returns an empty array (string-keyed runtime)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { a: 1, b: 2 };
           return Object.getOwnPropertySymbols(o).length;
         }`,
      ),
    ).toBe(0);
  });

  it("getOwnPropertyDescriptors materialises a data descriptor per own key", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { a: 7 };
           const d: any = Object.getOwnPropertyDescriptors(o);
           // d.a is the descriptor object; read its value back.
           return d.a.value;
         }`,
      ),
    ).toBe(7);
  });

  it("getOwnPropertyDescriptors covers all own keys", async () => {
    // Verify both keys' descriptors via `===` (avoid `+` on two `any` values,
    // which hits the unrelated boxed-add gap #42). The descriptor reads
    // themselves are correct (see the single-key value test above).
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { a: 1, b: 2 };
           const d: any = Object.getOwnPropertyDescriptors(o);
           return d.a.value === 1 && d.b.value === 2 ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("getOwnPropertyNames on a non-object-shaped receiver compiles (empty result path)", async () => {
    // Defensive: the helper returns an empty $ObjVec for a non-$Object receiver
    // rather than trapping. Exercised via an empty object (zero own keys).
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = {};
           return Object.getOwnPropertyNames(o).length;
         }`,
      ),
    ).toBe(0);
  });

  it("Object.keys is unregressed by the __obj_ordered_all sibling", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { p: 1, q: 2 };
           return Object.keys(o).length;
         }`,
      ),
    ).toBe(2);
  });

  it("getOwnPropertyDescriptors compiles host-free (no leaked import)", async () => {
    expect(
      await compilesStandalone(
        `export function test(): number {
           const o: any = { a: 1 };
           const d: any = Object.getOwnPropertyDescriptors(o);
           return d.a.value;
         }`,
      ),
    ).toBe(true);
  });
});
