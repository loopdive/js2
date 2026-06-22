import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";
import type { CompileOptions } from "../src/index.js";

// #2594 (Part A) — standalone `ArrayBuffer.isView` host-import leak.
//   On --target standalone the arm always emitted `ensureLateImport(
//   "__arraybuffer_isView")`, leaking an `env.*` import → the WHOLE module
//   failed to instantiate ("Import #0 'env': module is not an object or
//   function"). §25.1.4.1: isView is true iff the arg has a
//   [[ViewedArrayBuffer]] slot (any TypedArray or DataView). Now decided
//   host-free: static-decide on the resolvable arg type, with a vec/DataView-
//   window `ref.test` fallback for `any`/union args.
//
//   Part B (BigInt64Array / BigUint64Array native ctor) is split to a follow-up
//   gated on the i64-bigint-brand decision (#1349/#1644), per the issue spec.
async function run(source: string, opts: CompileOptions = {}): Promise<Record<string, Function>> {
  const result = await compile(source, opts);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const built = buildImports(result.imports, undefined, result.stringPool);
  // instantiateWasm throwing on a leaked `env` import is exactly the bug this
  // fixes — a clean instantiate standalone is the core assertion.
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#2594 — ArrayBuffer.isView native standalone (no env leak)", () => {
  it("isView(new Int32Array(4)) === true (standalone)", async () => {
    const e = await run(`export function test(): boolean { return ArrayBuffer.isView(new Int32Array(4)); }`, {
      target: "standalone",
    });
    expect(Boolean(e.test!())).toBe(true);
  });

  it("isView(new DataView(buf)) === true (standalone)", async () => {
    const e = await run(
      `export function test(): boolean {
         const buf = new ArrayBuffer(8);
         return ArrayBuffer.isView(new DataView(buf));
       }`,
      { target: "standalone" },
    );
    expect(Boolean(e.test!())).toBe(true);
  });

  it("isView(new ArrayBuffer(8)) === false — a buffer is not a view (standalone)", async () => {
    const e = await run(`export function test(): boolean { return ArrayBuffer.isView(new ArrayBuffer(8)); }`, {
      target: "standalone",
    });
    expect(Boolean(e.test!())).toBe(false);
  });

  it("isView(42 as any) === false (standalone runtime fallback)", async () => {
    const e = await run(`export function test(): boolean { return ArrayBuffer.isView(42 as any); }`, {
      target: "standalone",
    });
    expect(Boolean(e.test!())).toBe(false);
  });

  it("isView(null as any) === false (standalone)", async () => {
    const e = await run(`export function test(): boolean { return ArrayBuffer.isView(null as any); }`, {
      target: "standalone",
    });
    expect(Boolean(e.test!())).toBe(false);
  });

  it("a whole module using isView instantiates + computes standalone", async () => {
    // The env leak previously broke the ENTIRE module at instantiate; this
    // exercises the full happy path (view, non-view buffer, DataView).
    const e = await run(
      `export function test(): number {
         const a = new Int32Array(4);
         const buf = new ArrayBuffer(8);
         let n = 0;
         if (ArrayBuffer.isView(a)) n += 1;
         if (!ArrayBuffer.isView(buf)) n += 10;
         if (ArrayBuffer.isView(new DataView(buf))) n += 100;
         return n; // 111
       }`,
      { target: "standalone" },
    );
    expect(e.test!()).toBe(111);
  });

  it("isView(ArrayBuffer) / isView(null) also resolve in gc/host (host-recognizable args)", async () => {
    // gc/host keeps the host import; an opaque Wasm-native TypedArray is NOT a
    // real JS view to the host, so only host-recognizable non-views are
    // asserted here (the standalone tests above cover view recognition).
    const bufE = await run(`export function test(): boolean { return ArrayBuffer.isView(new ArrayBuffer(8)); }`);
    expect(Boolean(bufE.test!())).toBe(false);
    const nullE = await run(`export function test(): boolean { return ArrayBuffer.isView(null as any); }`);
    expect(Boolean(nullE.test!())).toBe(false);
  });
});
