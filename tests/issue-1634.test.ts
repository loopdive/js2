import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #1634 — AggregateError accepts any iterable errors (array literal, Set);
// SuppressedError gets a spec-faithful dedicated constructor; both install
// `cause` from options via HasProperty semantics.
//
// Construction happens INSIDE the exported `test` function (after setExports),
// matching how test262 / the real driver run — the host needs the module's
// `__vec_len`/`__sget_*` exports to materialize WasmGC vec/struct arguments.
async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts" });
  if (!r.success) throw new Error("CE: " + (r.errors[0]?.message ?? "unknown"));
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  if (typeof imports.setExports === "function") {
    (imports.setExports as (e: unknown) => void)(instance.exports);
  }
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#1634 AggregateError / SuppressedError iterable + cause", () => {
  it("AggregateError errors from an array literal", async () => {
    const out = await run(
      `export function test(): number { const e = new AggregateError([1, 2, 3]); return e.errors.length; }`,
    );
    expect(out).toBe(3);
  });

  it("AggregateError errors from a Set (any iterable)", async () => {
    const out = await run(
      `export function test(): number { const s = new Set([1, 2]); const e = new AggregateError(s); return e.errors.length; }`,
    );
    expect(out).toBe(2);
  });

  it("AggregateError errors property is a real Array", async () => {
    const out = await run(
      `export function test(): number { const e = new AggregateError([1, 2, 3]); return Array.isArray(e.errors) ? 1 : 0; }`,
    );
    expect(out).toBe(1);
  });

  it("AggregateError installs cause from options (object identity preserved)", async () => {
    const out = await run(
      `export function test(): number { const cause = { m: 1 }; const e = new AggregateError([], "msg", { cause }); return ((e as any).cause === cause) ? 1 : 0; }`,
    );
    expect(out).toBe(1);
  });

  it("AggregateError: no cause property when options omitted", async () => {
    const out = await run(
      `export function test(): number { const e = new AggregateError([], "msg"); return ("cause" in (e as any)) ? 1 : 0; }`,
    );
    expect(out).toBe(0);
  });

  it("AggregateError: cause installed even when options.cause is undefined (HasProperty)", async () => {
    const out = await run(
      `export function test(): number { const o = { cause: undefined }; const e = new AggregateError([], "msg", o); return ("cause" in (e as any)) ? 1 : 0; }`,
    );
    expect(out).toBe(1);
  });

  it("AggregateError(undefined) throws TypeError (not iterable)", async () => {
    const out = await run(
      `export function test(): number { let t = 0; try { new AggregateError(undefined as any); } catch (e) { if (e instanceof TypeError) t = 1; } return t; }`,
    );
    expect(out).toBe(1);
  });

  it("SuppressedError stores error and suppressed (reference identity)", async () => {
    const out = await run(
      `export function test(): number { const err = { a: 1 }; const sup = { b: 2 }; const e = new SuppressedError(err, sup, "m"); return ((e as any).error === err && (e as any).suppressed === sup) ? 1 : 0; }`,
    );
    expect(out).toBe(1);
  });

  it("SuppressedError coerces message to string", async () => {
    const out = await run(
      `export function test(): number { const e = new SuppressedError(1, 2, "hello"); return e.message === "hello" ? 1 : 0; }`,
    );
    expect(out).toBe(1);
  });

  it("SuppressedError: no cause property when options omitted", async () => {
    const out = await run(
      `export function test(): number { const e = new SuppressedError(1, 2, "m"); return ("cause" in (e as any)) ? 1 : 0; }`,
    );
    expect(out).toBe(0);
  });
});
