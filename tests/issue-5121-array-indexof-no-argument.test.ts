import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #5121 S1 — `Array.prototype.indexOf` / `lastIndexOf` with NO argument answered
//   `0` instead of searching for `undefined`.
//
//   §23.1.3.13 / §23.1.3.20 take `searchElement` as an ordinary parameter, so
//   the zero-argument form is legal JS: it searches for `undefined` with STRICT
//   equality (holes are skipped via HasProperty).
//
//   Root cause (src/codegen/array-methods.ts): both impls opened with a hard
//   `indexOf requires 1 argument` reportError + `return null`, whose diagnostic
//   the caller SWALLOWS — `compile()` reports `success: true` with an EMPTY
//   errors array — collapsing the call into a degraded fallback that evaluates
//   to `0`. Identified by HASH, not by analogy: before the fix `a.indexOf()`,
//   `a.lastIndexOf()` and (pre-#5095) `a.at()` all compiled to the SAME binary.
//
//   Fix: emit the absent `searchElement` as whatever an explicit `undefined`
//   would produce for the element type, exactly as `includes` already does
//   (`emitIncludesSearchValue`, #2872) — with one deliberate difference, since
//   `indexOf` uses `===` where `includes` uses SameValueZero.
//
//   NOT fixed here (issue #5121 "S2"): an f64 vec cannot tell a hole from a real
//   `undefined` — both read as NaN — so `[10, undefined, 30].indexOf()` answers
//   -1 where the spec says 1. That is equally wrong for the explicit
//   `indexOf(undefined)` spelling, so it is pinned below as an EQUALITY between
//   the two spellings, never as a spec literal.
//
//   `skipSemanticDiagnostics` mirrors the test262 runner — TS types these
//   methods as requiring an argument, which is not a hard error there.

interface CompileResult {
  success: boolean;
  errors?: Array<{ message: string }>;
  binary: Uint8Array;
  importObject?: WebAssembly.Imports;
}

async function build(src: string, standalone: boolean): Promise<CompileResult> {
  const opts = standalone ? { target: "standalone", skipSemanticDiagnostics: true } : { skipSemanticDiagnostics: true };
  const r = (await compile(src, opts as never)) as never as CompileResult;
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  return r;
}

async function runGc(src: string): Promise<unknown> {
  const r = await build(src, false);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): unknown }).test();
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await build(src, true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

async function digestGc(src: string): Promise<string> {
  const r = await build(src, false);
  return createHash("sha256").update(r.binary).digest("hex");
}

const fn = (body: string) => `export function test(): number { ${body} }`;
const NUM = "const a=[10,20,30];";
const STRU = 'const a=["x",undefined,"z"];';
const ANY = 'const a=(["1",undefined,3] as any[]);';

describe("#5121 S1 — Array.prototype.indexOf/lastIndexOf with no argument", () => {
  // The headline rows.
  it("[10,20,30].indexOf() / .lastIndexOf() → -1 (gc)", async () => {
    expect(await runGc(fn(`${NUM} return a.indexOf() as number;`))).toBe(-1);
    expect(await runGc(fn(`${NUM} return a.lastIndexOf() as number;`))).toBe(-1);
  });

  it("[10,20,30].indexOf() / .lastIndexOf() → -1 (standalone)", async () => {
    expect(await runStandalone(fn(`${NUM} return a.indexOf() as number;`))).toBe(-1);
    expect(await runStandalone(fn(`${NUM} return a.lastIndexOf() as number;`))).toBe(-1);
  });

  // The absent argument is a SEARCH VALUE, not a hard-wired -1: on an externref
  // vec that really holds `undefined`, it finds it.
  it("['x',undefined,'z'].indexOf() → 1 (gc)", async () => {
    expect(await runGc(fn(`${STRU} return a.indexOf() as number;`))).toBe(1);
    expect(await runGc(fn(`${STRU} return a.lastIndexOf() as number;`))).toBe(1);
  });

  it("the any[] spelling finds undefined too, in both lanes", async () => {
    expect(await runGc(fn(`${ANY} return a.indexOf() as number;`))).toBe(1);
    expect(await runStandalone(fn(`${ANY} return a.indexOf() as number;`))).toBe(1);
    expect(await runStandalone(fn(`${ANY} return a.lastIndexOf() as number;`))).toBe(1);
  });

  it("empty and string arrays → -1 (both lanes)", async () => {
    const empty = "const a: number[]=[];";
    expect(await runGc(fn(`${empty} return a.indexOf() as number;`))).toBe(-1);
    expect(await runStandalone(fn(`${empty} return a.lastIndexOf() as number;`))).toBe(-1);
    expect(await runGc(fn(`const a=["x","y"]; return a.indexOf() as number;`))).toBe(-1);
    expect(await runStandalone(fn(`const a=["x","y"]; return a.indexOf() as number;`))).toBe(-1);
  });

  // An i32 (boolean) vec can hold no `undefined`, so nothing can match. Before
  // the fix this answered 0 — which is also where `false` sits, so the wrong
  // answer looked plausible.
  it("[false,true].indexOf() → -1, not the index of false (both lanes)", async () => {
    expect(await runGc(fn(`const a=[false,true]; return a.indexOf() as number;`))).toBe(-1);
    expect(await runStandalone(fn(`const a=[false,true]; return a.lastIndexOf() as number;`))).toBe(-1);
  });

  // TypedArray receivers share this lowering, so they carried the same defect.
  it("TypedArray receivers → -1 (both lanes)", async () => {
    const i32 = "const t=new Int32Array(3); t[0]=7;";
    expect(await runGc(fn(`${i32} return t.indexOf() as number;`))).toBe(-1);
    expect(await runGc(fn(`${i32} return t.lastIndexOf() as number;`))).toBe(-1);
    expect(await runStandalone(fn(`${i32} return t.indexOf() as number;`))).toBe(-1);
    expect(await runGc(fn(`const t=new Float64Array(2); t[0]=7; return t.indexOf() as number;`))).toBe(-1);
  });

  // The collapse, asserted as gone: the two no-argument forms shared ONE binary
  // with each other (and with `at()` before #5095). Distinct hashes now.
  it("the shared degraded-fallback binary is gone", async () => {
    const iof = await digestGc(fn(`${NUM} return a.indexOf() as number;`));
    const liof = await digestGc(fn(`${NUM} return a.lastIndexOf() as number;`));
    const at = await digestGc(fn(`${NUM} return a.at() as number;`));
    expect(iof).not.toBe(liof);
    expect(iof).not.toBe(at);
    expect(liof).not.toBe(at);
  });

  // On an externref vec the absent argument compiles byte-identically to the
  // explicit `undefined`, so the two spellings cannot drift apart.
  it("gc: indexOf() is byte-identical to indexOf(undefined) on an externref vec", async () => {
    for (const decl of [STRU, ANY, 'const a=["x","y"];']) {
      expect(await digestGc(fn(`${decl} return a.indexOf() as number;`))).toBe(
        await digestGc(fn(`${decl} return a.indexOf(undefined) as number;`)),
      );
    }
    expect(await digestGc(fn(`${STRU} return a.lastIndexOf() as number;`))).toBe(
      await digestGc(fn(`${STRU} return a.lastIndexOf(undefined) as number;`)),
    );
  });

  // S2 BOUNDARY — deliberately an equality, NOT a spec literal. In an f64 vec a
  // hole and an `undefined` both read as NaN, and `===` matches neither, so this
  // answers -1 where the spec says 1. The point of the assertion is only that
  // the absent-argument form cannot disagree with the explicit one; fixing the
  // value needs a tagged element representation (#5121 S2, still open).
  it("S2: f64-vec undefined is indistinguishable from a hole — both spellings agree", async () => {
    const NUMU = "const a=[10,undefined,30];";
    for (const lane of [runGc, runStandalone]) {
      expect(await lane(fn(`${NUMU} return a.indexOf() as number;`))).toBe(
        await lane(fn(`${NUMU} return a.indexOf(undefined) as number;`)),
      );
      expect(await lane(fn(`${NUMU} return a.lastIndexOf() as number;`))).toBe(
        await lane(fn(`${NUMU} return a.lastIndexOf(undefined) as number;`)),
      );
    }
  });

  // Explicit-argument regression guards. Every one of these was measured
  // byte-identical across the fix (file-copy A/B on src/codegen/array-methods.ts).
  it("explicit-argument forms keep their answers", async () => {
    const A = "const a=[10,20,30];";
    expect(await runGc(fn(`${A} return a.indexOf(20) as number;`))).toBe(1);
    expect(await runGc(fn(`${A} return a.lastIndexOf(20) as number;`))).toBe(1);
    expect(await runGc(fn(`${A} return a.indexOf(20,1) as number;`))).toBe(1);
    expect(await runGc(fn(`${A} return a.lastIndexOf(20,2) as number;`))).toBe(1);
    expect(await runStandalone(fn(`${A} return a.indexOf(20) as number;`))).toBe(1);
    expect(await runGc(fn(`${STRU} return a.indexOf(undefined) as number;`))).toBe(1);
    expect(await runGc(fn(`const a=[1,NaN,3]; return a.indexOf(NaN) as number;`))).toBe(-1);
    // (#2648) packed-element signedness must still drive the load.
    expect(await runGc(fn(`const t=new Int8Array(2); t[1]=-1; return t.indexOf(-1) as number;`))).toBe(1);
  });

  // Neighbouring methods that must not move: `includes()` was already correct
  // (#2872), `at()` was fixed by #5095, and String.prototype has its own
  // lowering entirely.
  it("includes() and at() with no argument are unchanged", async () => {
    expect(await runGc(fn(`${NUM} return a.includes() ? 1 : 0;`))).toBe(0);
    expect(await runGc(fn(`const a=[10,undefined,30]; return a.includes() ? 1 : 0;`))).toBe(1);
    expect(await runGc(fn(`${NUM} return a.at() as number;`))).toBe(10);
    expect(await runGc(fn(`${NUM} return a.at(0) as number;`))).toBe(10);
  });

  it("String.prototype.indexOf (a different lowering) is unchanged", async () => {
    expect(await runGc(fn(`return "abc".indexOf("b") as number;`))).toBe(1);
    expect(await runGc(fn(`return "abc".indexOf() as number;`))).toBe(-1);
    expect(await runGc(fn(`return "abc".lastIndexOf() as number;`))).toBe(-1);
  });
});
