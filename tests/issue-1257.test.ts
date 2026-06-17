// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1257 — funcIdx-shift corruption in detached instruction arrays.
//
// `collectInstrs` (and the older save-body/swap pattern) hands back a DETACHED
// Instr[]; if the caller then triggers a late import (e.g. buildDestructureNull-
// Throw → ensureLateImport("__throw_type_error")) before the array is spliced
// into a walked body, `shiftLateImportIndices` cannot reach it and every `call`
// inside keeps a pre-shift funcIdx. The PR #225 manifestation pointed the
// destructure-null TypeError throw at the outer function itself → infinite
// recursion (RangeError) for `{ x = f() } = null`.
//
// The hazard sites have since been wired to register their detached arrays in
// `ctx.liveBodies` (the registry `shiftLateImportIndices` walks — the concrete
// realization of the issue's "Option A: ctx.detachedBodies stack") and the
// emitNullGuard path pre-registers its late imports. This file is the
// regression net proving none of the spec scenarios recurse or mis-index:
// each compiles to VALID Wasm, instantiates, and throws a catchable TypeError
// (returns 1) rather than trapping/recursing.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function runCatch(source: string): Promise<{ value: unknown; valid: boolean }> {
  const r = await compile(source);
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const valid = WebAssembly.validate(r.binary);
  const imports = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports);
  const value = await (instance.exports as Record<string, () => unknown>).test();
  return { value, valid };
}

describe("#1257 — detached-array funcIdx shift (destructure-null throw paths)", () => {
  it("object default-init destructure of null throws (no infinite recursion)", async () => {
    const { value, valid } = await runCatch(`
      function g(): number { const o: any = ({a = 5} = null as any); return 0; }
      export function test(): number { try { g(); return 0; } catch (e) { return 1; } }
    `);
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("empty object pattern assigned null throws", async () => {
    const { value, valid } = await runCatch(`
      export function test(): number { try { (({} = null as any)); return 0; } catch (e) { return 1; } }
    `);
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("empty array pattern assigned null throws", async () => {
    const { value, valid } = await runCatch(`
      export function test(): number { try { (([] = null as any)); return 0; } catch (e) { return 1; } }
    `);
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("object default-init whose initializer calls a host builtin still shifts correctly", async () => {
    const { value, valid } = await runCatch(`
      function g(): number { const o: any = ({a = Math.floor(1.5)} = null as any); return 0; }
      export function test(): number { try { g(); return 0; } catch (e) { return 1; } }
    `);
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("object default-init whose initializer calls a user function still shifts correctly", async () => {
    const { value, valid } = await runCatch(`
      let a: any;
      function f(): number { return 7; }
      export function test(): number { try { (({a = f()} = null as any)); return 0; } catch (e) { return 1; } }
    `);
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("multiple nested destructure-null throws in one function all shift correctly", async () => {
    const { value, valid } = await runCatch(`
      function g(): number {
        try { (({a} = null as any)); } catch (e) {}
        try { (([b] = null as any)); } catch (e) {}
        const o: any = ({c = "x"} = null as any);
        return 0;
      }
      export function test(): number { try { g(); return 0; } catch (e) { return 1; } }
    `);
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("async generator: yield ({} = null) throws-then-caught without recursion", async () => {
    // `({} = null)` throws synchronously while evaluating the yield argument,
    // BEFORE the first yield suspends; the catch swallows it and control reaches
    // `yield 9`, so the FIRST next() resolves to {value: 9}. (If the throw had
    // mis-indexed into recursion, this would trap/time out instead.)
    const { value, valid } = await runCatch(`
      async function* g(): AsyncGenerator<number> { try { yield (({} = null as any)); } catch (e) {} yield 9; }
      export async function test(): Promise<number> {
        const it = g();
        const r = await it.next();
        return (r.value as number) === 9 ? 1 : 0;
      }
    `);
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("async generator: object default-init throw then a later host call (late-import after detached array)", async () => {
    const { value, valid } = await runCatch(`
      async function* g(): AsyncGenerator<number> {
        try { const o: any = ({a = parseInt("3")} = null as any); } catch (e) {}
        yield 9;
      }
      export async function test(): Promise<number> {
        const it = g();
        const r = await it.next();
        return (r.value as number) === 9 ? 1 : 0;
      }
    `);
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });
});
