import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #5095 — `Array.prototype.at` with NO argument answered the *index* instead of
//   the element: `[10,20,30].at()` returned `0` (and `undefined` in value
//   position) instead of `10`.
//
//   §23.1.3.1 takes `index` as an ordinary parameter, so the zero-argument form
//   is legal JS and is exactly `at(0)`: ToNumber(undefined) is NaN and
//   ToIntegerOrInfinity(NaN) is +0 (§7.1.5 step 2).
//
//   Root cause (src/codegen/array-methods.ts, compileArrayAt): the native WasmGC
//   vec lowering opened with a hard `at() requires 1 argument` reportError +
//   `return null`, which the caller swallowed into its degraded fallback. The two
//   wrong spellings in the report (`0` in string position, `undefined` in value
//   position) were that one collapse seen through two coercion paths — measured
//   by hash: pre-fix `a.at()` compiled to the SAME binary as `a.indexOf()` and
//   `a.lastIndexOf()`, the other two methods that still hard-require their
//   argument (that sibling defect is NOT fixed here — see the issue file).
//
//   Fix: treat the absent argument as index 0, exactly as `includes` already
//   models its absent `searchElement` (`emitIncludesSearchValue`, #2872). In
//   gc/host mode the emitted binary for `at()` is byte-identical to `at(0)` and
//   `at(undefined)` — asserted below, so the three spellings cannot drift apart.
//
//   `skipSemanticDiagnostics` mirrors the test262 runner — TS types `at` as
//   requiring an argument, which is not a hard error there.

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

const ARR = "const a=[10,20,30];";

describe("#5095 Array.prototype.at() with no argument", () => {
  // The headline bug, in both spellings the report gave.
  it("value position: [10,20,30].at() → 10 (gc)", async () => {
    expect(await runGc(`export function test(): number { ${ARR} return a.at() as number; }`)).toBe(10);
  });

  it("value position: [10,20,30].at() → 10 (standalone)", async () => {
    expect(await runStandalone(`export function test(): number { ${ARR} return a.at() as number; }`)).toBe(10);
  });

  it('string position: "" + [10,20,30].at() → "10" (gc)', async () => {
    expect(await runGc(`export function test(): string { ${ARR} return "" + a.at(); }`)).toBe("10");
  });

  // A TypedArray receiver shares this exact lowering, so it carried the same
  // defect (the #5095 report listed it as already-correct — it was not).
  it("TypedArray receiver: Int32Array at() → element 0 (gc)", async () => {
    expect(
      await runGc(
        `export function test(): number { const t=new Int32Array(3); t[0]=7; return t.at(0+0-0) as number; }`,
      ),
    ).toBe(7);
    expect(
      await runGc(`export function test(): number { const t=new Int32Array(3); t[0]=7; return t.at() as number; }`),
    ).toBe(7);
  });

  it("TypedArray receiver: Int32Array at() → element 0 (standalone)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const t=new Int32Array(3); t[0]=7; return t.at() as number; }`,
      ),
    ).toBe(7);
  });

  // Empty receiver: index 0 is out of bounds, so at() must behave exactly as
  // at(0) does. Asserted as an EQUALITY against at(0) rather than a literal,
  // because the native vec lowering renders an out-of-bounds read of a number
  // vec as NaN rather than undefined — a pre-existing, separate residual that
  // this issue does not change and must not silently pin as correct.
  it("empty array: at() behaves exactly as at(0) (gc)", async () => {
    const noArg = await runGc(`export function test(): string { const a: number[]=[]; return "" + a.at(); }`);
    const zero = await runGc(`export function test(): string { const a: number[]=[]; return "" + a.at(0); }`);
    expect(noArg).toBe(zero);
  });

  it("empty array: at() behaves exactly as at(0) (standalone, value position)", async () => {
    const noArg = await runStandalone(
      `export function test(): number { const a: number[]=[]; return a.at() as number; }`,
    );
    const zero = await runStandalone(
      `export function test(): number { const a: number[]=[]; return a.at(0) as number; }`,
    );
    expect(noArg).toBe(zero);
  });

  // Byte-identity: the three spellings of "index 0" must compile to the same
  // module in gc/host mode, so they cannot drift apart later.
  it("gc: at() compiles byte-identically to at(0) and at(undefined)", async () => {
    const noArg = await digestGc(`export function test(): number { ${ARR} return a.at() as number; }`);
    const zero = await digestGc(`export function test(): number { ${ARR} return a.at(0) as number; }`);
    const undef = await digestGc(`export function test(): number { ${ARR} return a.at(undefined) as number; }`);
    expect(noArg).toBe(zero);
    expect(noArg).toBe(undef);
  });

  // Already-correct forms — regression guards. Each was byte-identical before
  // and after the fix (measured A/B on src/codegen/array-methods.ts).
  it("at(0) / at(undefined) / at(NaN) keep answering 10", async () => {
    expect(await runGc(`export function test(): number { ${ARR} return a.at(0) as number; }`)).toBe(10);
    expect(await runGc(`export function test(): number { ${ARR} return a.at(undefined) as number; }`)).toBe(10);
    expect(await runGc(`export function test(): number { ${ARR} return a.at(NaN) as number; }`)).toBe(10);
    expect(await runStandalone(`export function test(): number { ${ARR} return a.at(0) as number; }`)).toBe(10);
    expect(await runStandalone(`export function test(): number { ${ARR} return a.at(NaN) as number; }`)).toBe(10);
  });

  it("negative index still wraps from the end", async () => {
    expect(await runGc(`export function test(): number { ${ARR} return a.at(-1) as number; }`)).toBe(30);
    expect(await runGc(`export function test(): number { ${ARR} return a.at(-3) as number; }`)).toBe(10);
    expect(await runStandalone(`export function test(): number { ${ARR} return a.at(-1) as number; }`)).toBe(30);
  });

  it("#2644 string-index ToIntegerOrInfinity path unchanged", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at("1"); }`)).toBe(11);
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at("-2.5"); }`)).toBe(
      12,
    );
  });

  it("String.prototype.at() (a different lowering) is unchanged", async () => {
    expect(await runGc(`export function test(): string { return "abc".at() as string; }`)).toBe("a");
    expect(await runGc(`export function test(): string { return "abc".at(1) as string; }`)).toBe("b");
  });

  // Sibling probe, recorded as a NEAR-MISS rather than ignored: `includes()`
  // with no argument was already correct (#2872 fixed it there) and must stay
  // so. `indexOf()`/`lastIndexOf()` with no argument are still WRONG (they
  // answer 0 where §23.1.3.13/§23.1.3.20 require -1) — deliberately NOT pinned
  // here, and written up as a follow-up in the issue file.
  it("includes() with no argument stays correct (already fixed by #2872)", async () => {
    expect(await runGc(`export function test(): boolean { ${ARR} return a.includes(); }`)).toBeFalsy();
    expect(
      await runGc(`export function test(): boolean { const a=[10,undefined,30]; return a.includes(); }`),
    ).toBeTruthy();
  });
});
