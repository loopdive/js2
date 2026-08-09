// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `generateMultiModule` (the compileMulti/compileFiles path) never called
// `fillArrayToPrimitive` / `fillClassToPrimitive`, unlike the single-file
// `generateModule` path. Both are "reserve a placeholder now, patch its body
// in post-processing" drivers backing `__to_primitive`'s array/class-instance
// arms (needed whenever a standalone build must ToNumber/ToString a plain
// object or array, e.g. via a TypedArray.prototype.set offset argument). With
// the fill never called, the reserved driver kept its bare `unreachable` stub
// body — so any standalone MULTI-file compile that actually reached one of
// these arms crashed the whole module with an uncatchable Wasm trap instead
// of producing the (fully well-defined) coerced value.
//
// This is precisely the class of failure the #3189 uncatchable-trap ratchet
// guards against (see typed-array-set-bounds.ts and issue-3202.test.ts for
// the sibling OOB-bounds-check fix in the same function) — discovered via a
// 2026-07-27/28 test262 "oob"-trap-growth block on
// test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

async function runStandaloneMulti(src: string): Promise<{ envImports: string[]; result: number }> {
  const files = { "entry.ts": src };
  const r = await compileMulti(files, "entry.ts", { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "standalone multi-file module failed WebAssembly.validate").toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  const envImports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const instance = new WebAssembly.Instance(mod, {});
  const result = (instance.exports as { run: () => number }).run();
  return { envImports, result };
}

describe("standalone compileMulti fills __to_primitive array/class drivers", () => {
  it("TypedArray.prototype.set(arr, offset) with a plain-object offset does not trap", async () => {
    const { result } = await runStandaloneMulti(
      `export function run(): number {
         const sample = new Int8Array([1, 2]);
         sample.set([42], {} as any); // ToNumber({}) -> NaN -> ToInteger -> 0
         return sample[0] * 100 + sample[1];
       }`,
    );
    expect(result).toBe(4202);
  });

  it("TypedArray.prototype.set(arr, offset) with an array offset coerces via join(',')", async () => {
    const { result } = await runStandaloneMulti(
      `export function run(): number {
         const sample = new Int8Array([1, 2]);
         sample.set([42], [1] as any); // ToNumber([1]) -> "1" -> 1
         return sample[0] * 100 + sample[1];
       }`,
    );
    expect(result).toBe(142);
  });

  it("does not leak a host env import for the object/array coercion", async () => {
    const { envImports } = await runStandaloneMulti(
      `export function run(): number {
         const sample = new Int8Array([1, 2]);
         sample.set([42], [0] as any);
         return sample[0] * 100 + sample[1];
       }`,
    );
    expect(envImports.length).toBe(0);
  });
});
