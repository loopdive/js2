// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tests for #1637 — Boolean.prototype.toString/valueOf receiver coercion.
 *
 * §20.3.3.2/.3 thisBooleanValue accepts a Boolean primitive or a Boolean
 * wrapper. Calling `Boolean.prototype.toString.call(prim)` routes through the
 * __extern_method_call host import (method="call"); Boolean primitives travel
 * i32→externref via __box_number, so the receiver arrives as a number. Before
 * this fix the native method threw "requires that 'this' be a Boolean" instead
 * of returning "true"/"false". The fix coerces a numeric/bigint receiver back
 * to a boolean primitive for Boolean.prototype.{toString,valueOf} call/apply.
 *
 * The Symbol→string implicit-coercion half of #1637 is deferred — it requires
 * reworking the Symbol value representation in concat codegen (Symbols are
 * materialized as numeric handles, so binary-+ lowers through number_toString
 * rather than the throwing __concat_* path). Tracked in the issue file.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, {}, r.stringPool) as Record<string, unknown> & {
    setExports?: (e: Record<string, Function>) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, built as WebAssembly.Imports);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#1637 — Boolean.prototype receiver coercion", () => {
  it('Boolean.prototype.toString.call(0) === "false"', async () => {
    const r = await run(`export function test(): string { return (Boolean.prototype.toString as any).call(0); }`);
    expect(r).toBe("false");
  });

  it('Boolean.prototype.toString.call(1) === "true"', async () => {
    const r = await run(`export function test(): string { return (Boolean.prototype.toString as any).call(1); }`);
    expect(r).toBe("true");
  });

  it("Boolean.prototype.valueOf.call(true) === true", async () => {
    const r = await run(
      `export function test(): number { return (Boolean.prototype.valueOf as any).call(true) === true ? 1 : 0; }`,
    );
    expect(r).toBe(1);
  });

  it("Boolean.prototype.valueOf.call(false) === false", async () => {
    const r = await run(
      `export function test(): number { return (Boolean.prototype.valueOf as any).call(false) === false ? 1 : 0; }`,
    );
    expect(r).toBe(1);
  });

  it('Boolean.prototype.toString.call(true) === "true"', async () => {
    const r = await run(`export function test(): string { return (Boolean.prototype.toString as any).call(true); }`);
    expect(r).toBe("true");
  });
});
