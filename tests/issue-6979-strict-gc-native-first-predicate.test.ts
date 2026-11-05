// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6979 S7-a review — the native-first provider predicate is not the host axis.
 *
 * `{target:"gc", strictNoHostImports:true, nativeStrings:true}` resolves
 * `semanticProviders: "native-first"` while `ctx.standalone` and `ctx.wasi` are
 * both false. The `+` operand with a `toString`-only struct and the relational
 * numeric shortcut must keep their pre-S7 native-first shape on that profile
 * rather than fall back to the generic externref cascade.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const strictGc = { target: "gc", strictNoHostImports: true, nativeStrings: true } as const;

describe("#6979 strict-gc profile keeps the native-first provider arms", () => {
  it("`+` with a toString-closure object dispatches the closure in-module", async () => {
    const r = await compile('export function f(x:any){ const o={toString(){return "S";}}; return o + x; }', strictGc);
    expect(r.success).toBe(true);
    // The deferred string-hint conversion reads the struct's `toString` slot
    // (`__primitive_host_struct_*` locals); the generic path has none.
    expect(r.wat).toContain("__primitive_host_struct_");
  });

  it("relational `any` arm keeps the numeric shortcut (no boxed-constant cascade)", async () => {
    const r = await compile(
      'const o={n:1,toString(){return "S";}}; export function f(a:any,b:any){ return a < b || (o as any) < 3; }',
      strictGc,
    );
    expect(r.success).toBe(true);
    // Without the shortcut the literal `3` is boxed through a seeded externref
    // global (`$__const_box_*`) and compared through the host-style cascade.
    expect(r.wat).not.toContain("__const_box_");
  });
});
