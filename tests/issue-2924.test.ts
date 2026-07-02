// (#2924) `new Function("<const>")` compile-away MVP — slice 1 (JS-host lane).
//
// When every argument to `new Function(...)` is a compile-time-constant string,
// the constructor is compiled away into a real callable value (a global-scope
// function, no lexical capture — §20.2.1.1) on the JS-host lane. Non-constant
// args bail to the legacy no-op stub — never a miscompile.
//
// Slice-1 is deliberately HOST-LANE ONLY. The synthesized function has
// all-externref params, and externref-param closures hit a pre-existing
// standalone call-marshalling bug (two calls coexisting in one expression, or
// ≥3 args, silently return a wrong value — reproducible with a plain
// `function(a:any){…}`, so NOT this feature's bug). Rather than ship a silent
// wrong value in the standalone lane, the compile-away is gated to JS-host;
// standalone / WASI keep the pre-existing stub. Standalone enablement is #2945
// (blocked on the externref-param-closure standalone marshalling fix).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const io: Record<string, unknown> = (r as unknown as { importObject?: Record<string, unknown> }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, io as WebAssembly.Imports);
  (io.__setExports as ((e: unknown) => void) | undefined)?.(instance.exports);
  const exp = wrapExports(instance.exports, {
    signatures: (r as unknown as { exportSignatures?: unknown }).exportSignatures as never,
  }) as Record<string, (...a: unknown[]) => unknown>;
  return exp.test();
}

// Standalone: verify the compile-away is GATED OFF — the module compiles (bails
// to the legacy stub), instantiates with EMPTY imports (host-free), and does not
// trap. We deliberately do NOT assert the call's value (the stub is a no-op);
// the point is "no miscompile, no leak, no crash".
async function compileStandaloneCleanly(source: string): Promise<void> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  (instance.exports as Record<string, (...a: unknown[]) => unknown>).test();
}

describe("#2924 new Function(<const>) compile-away — slice 1 (host lane)", () => {
  it("two-param body, single call — host === 3", async () => {
    expect(
      await runHost(
        `export function test(): number { const f: any = new Function("a","b","return a+b"); return f(1,2); }`,
      ),
    ).toBe(3);
  });

  it("one-param body — host === 42", async () => {
    expect(
      await runHost(`export function test(): number { const f: any = new Function("x","return x*2"); return f(21); }`),
    ).toBe(42);
  });

  it("no-param body — host === 5", async () => {
    expect(
      await runHost(`export function test(): number { const f: any = new Function("return 5"); return f(); }`),
    ).toBe(5);
  });

  it("reuse across separate statements — host === 23", async () => {
    expect(
      await runHost(
        `export function test(): number { const f: any = new Function("a","return a+10"); const x: number = f(1); const y: number = f(2); return x+y; }`,
      ),
    ).toBe(23);
  });

  // NEGATIVE (host): a non-constant argument must bail to the legacy stub —
  // compiles, the result is the null "function" placeholder, no miscompile.
  it("non-constant arg bails gracefully to the stub (host)", async () => {
    const src = `export function make(s: any): any { return new Function(s); }
export function test(): number { const f: any = make("return 7"); return (f == null) ? 2 : (typeof f === "function" ? 1 : 3); }`;
    expect(await runHost(src)).toBe(2); // f == null (stub) — not a wrong-value miscompile
  });

  // Standalone lane is gated off (→ stub): must compile clean + host-free + not trap.
  it("standalone: gated to the stub — compiles host-free, no miscompile/trap", async () => {
    await compileStandaloneCleanly(
      `export function test(): number { const f: any = new Function("a","b","return a+b"); return typeof f === "function" ? 1 : 0; }`,
    );
  });
});
