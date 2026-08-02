// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4010 S1′ — the two disjoint array side tables clobbered each other.
//
// A named expando written by assignment lands in the #3537 BAG
// (`src/codegen/vec-props.ts`); a later `Object.defineProperty` on the same key
// lands in the #3251 COMPANION (`src/codegen/vec-overlay.ts`), which had never
// heard of it. `__extern_get`'s named-key prologue treats the companion as
// authoritative for any non-index key, so it returned the companion's
// never-populated value field and `arr.q` became `undefined`.
//
// The fix seeds the companion's PRE-STATE from the bag before delegating the
// define, so §10.1.6.3's existing preserve-the-[[Value]] rule has a value to
// preserve. It is the named-key twin of the pre-existing `seedIfRealElement`.
//
// SCOPE: this slice deliberately moves NO own-property visibility surface —
// `hasOwnProperty` / `Object.keys` / gOPD reach is unchanged. Per #4010's
// ordering law ("visibility cannot ship before deletability", the −684 receipt
// from #4055 v1), visibility widening waits for tombstones. The assertions
// below PIN that: they assert the value is preserved, and separately that the
// visibility answers are still the old ones. If a later slice changes those,
// these tests should be updated deliberately, not deleted.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const standaloneOpts = {
  fileName: "test.ts",
  emitWat: false,
  skipSemanticDiagnostics: true,
  target: "standalone" as const,
};

async function run(src: string): Promise<number> {
  const r = await compile(src, standaloneOpts);
  expect(r.success).toBe(true);
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  // Standalone must stay host-free: an import here means the module could not
  // instantiate in the real lane, and any assertion below would be vacuous.
  const mod = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#4010 S1′ — defineProperty no longer clobbers an array expando's value", () => {
  it("preserves the value when the descriptor omits [[Value]] (the reported defect)", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1, 2, 3];
  arr.q = 12;
  Object.defineProperty(arr, "q", { writable: false });
  return arr.q === 12 ? 1 : (arr.q === undefined ? 2 : 3);
}`),
    ).toBe(1);
  });

  it("an explicit [[Value]] in the descriptor still wins over the seeded one", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1, 2, 3];
  arr.q = 12;
  Object.defineProperty(arr, "q", { value: 99 });
  return arr.q === 99 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("defineProperty on a key the bag never held is unaffected", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1, 2, 3];
  Object.defineProperty(arr, "fresh", { value: 7, writable: true });
  return arr.fresh === 7 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("repeated attribute-only defines keep preserving the value", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = "keep";
  Object.defineProperty(arr, "q", { enumerable: false });
  Object.defineProperty(arr, "q", { configurable: false });
  return arr.q === "keep" ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("index keys are untouched — the pre-existing seedIfRealElement path still owns them", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1, 2, 3];
  Object.defineProperty(arr, "1", { writable: false });
  return arr[1] === 2 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("a plain expando with no define at all is unchanged", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = 12;
  return arr.q === 12 ? 1 : 2;
}`),
    ).toBe(1);
  });

  // ---- scope pins: these record what S1′ deliberately did NOT change --------
  // They are the #4010 ordering law in executable form. Flipping any of them is
  // S2/S3 work and must be accompanied by the tombstones + the mandatory
  // built-ins/**/{name,length}.js control run.
  it("SCOPE PIN: hasOwnProperty reach is unchanged (still answers from the overlay)", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = 12;
  return Object.prototype.hasOwnProperty.call(arr, "q") ? 1 : 2;
}`),
    ).toBe(2);
  });

  it("SCOPE PIN: Object.keys reach is unchanged", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = 12;
  const k = Object.keys(arr);
  for (let i = 0; i < k.length; i++) { if (k[i] === "q") return 1; }
  return 2;
}`),
    ).toBe(2);
  });
});
