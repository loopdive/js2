// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3384 — member access on a wrapped `JSON.parse()` call crashed codegen under
 * `--target standalone` / `--target wasi`.
 *
 * `tryEmitJsonParse{Property,Element}Access` guarded with
 * `isJsonParseCall(expr.expression)` (which unwraps transparent expressions
 * internally) but then read `expr.expression.arguments[0]` — undefined when the
 * call is wrapped in `as any` / parens / `!`, throwing "Cannot read properties
 * of undefined (reading '0')" → `Internal error compiling expression`. The fix
 * unwraps `expr.expression` to the real CallExpression before reading args.
 *
 * These tests pin: the wrapped forms compile host-free and statically fold to
 * the correct value on both standalone and wasi.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runStandaloneWasi(src: string): Promise<{ standalone: number; wasi: number }> {
  const out: Record<string, number> = {};
  for (const target of ["standalone", "wasi"] as const) {
    const r = await compile(src, { target });
    const hard = r.errors.filter((e) => (e.severity ?? "error") === "error");
    expect(hard, `${target}: ${hard[0]?.message ?? ""}`).toEqual([]);
    expect(r.success, `${target} compile`).toBe(true);
    // Host-free: instantiates with an EMPTY import object (no JS host).
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    out[target] = (instance.exports as { test?: () => number }).test!();
  }
  return { standalone: out.standalone!, wasi: out.wasi! };
}

describe("#3384 — wrapped JSON.parse member access no longer crashes codegen", () => {
  it("property access on `JSON.parse(...) as any`", async () => {
    const r = await runStandaloneWasi(`export function test(): number { return (JSON.parse('{"a":5}') as any).a; }`);
    expect(r).toEqual({ standalone: 5, wasi: 5 });
  });

  it("property access on a parenthesized JSON.parse call", async () => {
    const r = await runStandaloneWasi(`export function test(): number { return ((JSON.parse('{"a":8}'))).a as any; }`);
    expect(r).toEqual({ standalone: 8, wasi: 8 });
  });

  it("property access on a non-null-asserted JSON.parse call", async () => {
    const r = await runStandaloneWasi(`export function test(): number { return (JSON.parse('{"a":9}')!).a; }`);
    expect(r).toEqual({ standalone: 9, wasi: 9 });
  });

  it("element access on `JSON.parse(<object>) as any`", async () => {
    const r = await runStandaloneWasi(`export function test(): number { return (JSON.parse('{"a":7}') as any)["a"]; }`);
    expect(r).toEqual({ standalone: 7, wasi: 7 });
  });

  it("element access on `JSON.parse(<array>) as any`", async () => {
    const r = await runStandaloneWasi(`export function test(): number { return (JSON.parse('[10,20]') as any)[1]; }`);
    expect(r).toEqual({ standalone: 20, wasi: 20 });
  });

  it("assigned-then-accessed form remains correct (regression guard)", async () => {
    const r = await runStandaloneWasi(
      `export function test(): number { const o = JSON.parse('{"a":5}'); return (o as any).a; }`,
    );
    expect(r).toEqual({ standalone: 5, wasi: 5 });
  });
});
