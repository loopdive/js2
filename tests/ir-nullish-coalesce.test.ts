// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IR Phase 1 — `??` nullish coalescing over reference-shaped operands.
//
// The selector accepts `??` shape-only (`isPhase1BinaryOp`); the lowerer
// (`lowerNullish` in from-ast.ts) implements it for the case where both
// operands lower to the same Wasm reference type (externref). A `string`
// value is externref-shaped, so `s ?? "fallback"` is the smallest source
// that exercises the path: the selector claims `pick`, and both the
// nullish (then-arm yields rhs) and non-nullish (else-arm yields lhs)
// branches must match legacy codegen.
//
// Bare `null` flowing into a reference-shaped context (the then-arm's
// implicit consumer) is covered by the same path: `lowerNullish` lowers
// the rhs with the lhs reference type as hint, and a `null` rhs would be
// materialised as `ref.null.extern` via the NullKeyword branch in
// `lowerExpr`. Non-reference operands throw clean fallback to legacy.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileAndInstantiate(source: string, experimentalIR: boolean): Promise<Record<string, unknown>> {
  const r = await compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const instance = await instantiateWithRuntime(r, ENV_STUB);
  return instance.exports as Record<string, unknown>;
}

function selectionFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return new Set(planIrCompilation(sf, { experimentalIR: true }).funcs);
}

describe("IR — `??` nullish coalescing over reference operands", () => {
  const PICK = `export function pick(s: string): string { return s ?? "fallback"; }`;

  it("selector claims a string `??` function", () => {
    expect(selectionFor(PICK).has("pick")).toBe(true);
  });

  it("non-nullish lhs yields the lhs (else-arm) — IR matches legacy", async () => {
    const legacy = await compileAndInstantiate(PICK, false);
    const ir = await compileAndInstantiate(PICK, true);
    expect((legacy.pick as (s: unknown) => unknown)("real")).toBe("real");
    expect((ir.pick as (s: unknown) => unknown)("real")).toBe("real");
  });

  it("nullish lhs yields the rhs (then-arm) — IR matches legacy", async () => {
    const legacy = await compileAndInstantiate(PICK, false);
    const ir = await compileAndInstantiate(PICK, true);
    expect((legacy.pick as (s: unknown) => unknown)(null)).toBe("fallback");
    expect((ir.pick as (s: unknown) => unknown)(null)).toBe("fallback");
  });

  it("numeric `??` lowers correctly (non-reference lhs falls back to legacy)", async () => {
    // The selector accepts `??` shape-only, so `pickNum` is *claimed*; but an
    // f64 lhs has no nullable representation in IR Phase 1, so `lowerNullish`
    // throws at lowering time and the function reverts to legacy codegen
    // (a lowering-time fallback, not a selection-time rejection). The user-
    // visible contract is that compilation still succeeds and is correct.
    const src = `export function pickNum(n: number): number { return n ?? 0; }`;
    const legacy = await compileAndInstantiate(src, false);
    const ir = await compileAndInstantiate(src, true);
    expect((legacy.pickNum as (n: number) => number)(7)).toBe(7);
    expect((ir.pickNum as (n: number) => number)(7)).toBe(7);
  });
});
