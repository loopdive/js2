// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1917 Step 0 — the single ValType coercion table (`coercionPlan`).
 *
 * Asserts the canonical scalar / numeric / box-unbox rows that the three
 * ValType matrices (coercionInstrs / callArgCoercionInstrs / fixBranchType) now
 * all delegate to. The headline guarantee of #1917: the externref→f64 and
 * ref→f64 conversions are NON-lossy (unbox via __unbox_number), not the
 * `drop; f64.const 0` the stack-balancer's fixBranchType used to emit — so a
 * branch result is coerced identically to a call argument.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { coercionPlan } from "../src/codegen/coercion-plan.js";
import type { Instr, ValType } from "../src/ir/types.js";

const BOX = 100;
const UNBOX = 200;
const H = { boxNumberIdx: BOX, unboxNumberIdx: UNBOX };

const f64: ValType = { kind: "f64" };
const i32: ValType = { kind: "i32" };
const i64: ValType = { kind: "i64" };
const ext: ValType = { kind: "externref" };
const refExt: ValType = { kind: "ref_extern" } as ValType;
const anyref: ValType = { kind: "anyref" };
const ref0: ValType = { kind: "ref", typeIdx: 0 } as ValType;
const refNull0: ValType = { kind: "ref_null", typeIdx: 0 } as ValType;

function ops(instrs: Instr[]): string[] {
  return instrs.map((i) => (i.op === "call" ? `call#${(i as { funcIdx: number }).funcIdx}` : i.op));
}

describe("#1917 coercionPlan — numeric / box-unbox table", () => {
  it("numeric ↔ numeric conversions are lossless arithmetic", () => {
    expect(ops(coercionPlan(i32, f64, H)!.instrs)).toEqual(["f64.convert_i32_s"]);
    expect(ops(coercionPlan(f64, i32, H)!.instrs)).toEqual(["i32.trunc_sat_f64_s"]);
    expect(ops(coercionPlan(i64, f64, H)!.instrs)).toEqual(["f64.convert_i64_s"]);
    expect(ops(coercionPlan(f64, i64, H)!.instrs)).toEqual(["i64.trunc_sat_f64_s"]);
    expect(ops(coercionPlan(i32, i64, H)!.instrs)).toEqual(["i64.extend_i32_s"]);
    expect(ops(coercionPlan(i64, i32, H)!.instrs)).toEqual(["i32.wrap_i64"]);
  });

  it("number → externref boxes via __box_number", () => {
    expect(ops(coercionPlan(f64, ext, H)!.instrs)).toEqual([`call#${BOX}`]);
    expect(ops(coercionPlan(i32, ext, H)!.instrs)).toEqual(["f64.convert_i32_s", `call#${BOX}`]);
    expect(ops(coercionPlan(i64, ext, H)!.instrs)).toEqual(["f64.convert_i64_s", `call#${BOX}`]);
  });

  it("externref → number unboxes via __unbox_number (NOT lossy drop)", () => {
    const p = coercionPlan(ext, f64, H)!;
    expect(ops(p.instrs)).toEqual([`call#${UNBOX}`]);
    expect(p.lossy).toBeFalsy();
    expect(ops(coercionPlan(ext, i32, H)!.instrs)).toEqual([`call#${UNBOX}`, "i32.trunc_sat_f64_s"]);
    expect(ops(coercionPlan(ext, i64, H)!.instrs)).toEqual([`call#${UNBOX}`, "i64.trunc_sat_f64_s"]);
  });

  it("ref/ref_null → f64 re-enters extern then unboxes (the #1917 branch divergence fix)", () => {
    const p = coercionPlan(ref0, f64, H)!;
    expect(ops(p.instrs)).toEqual(["extern.convert_any", `call#${UNBOX}`]);
    expect(p.lossy).toBeFalsy();
    expect(ops(coercionPlan(refNull0, f64, H)!.instrs)).toEqual(["extern.convert_any", `call#${UNBOX}`]);
  });

  it("ref/eqref/anyref → externref is extern.convert_any (lossless)", () => {
    expect(ops(coercionPlan(ref0, ext, H)!.instrs)).toEqual(["extern.convert_any"]);
    expect(ops(coercionPlan(anyref, ext, H)!.instrs)).toEqual(["extern.convert_any"]);
  });

  it("externref → anyref/eqref is any.convert_extern", () => {
    expect(ops(coercionPlan(ext, anyref, H)!.instrs)).toEqual(["any.convert_extern"]);
    expect(ops(coercionPlan(ext, { kind: "eqref" }, H)!.instrs)).toEqual(["any.convert_extern"]);
  });

  it("externref/ref_extern spellings are treated as the same type (no-op)", () => {
    expect(coercionPlan(ext, refExt, H)!.instrs).toEqual([]);
    expect(coercionPlan(refExt, ext, H)!.instrs).toEqual([]);
  });

  it("box/unbox rows return null when the helper funcIdx is unavailable (caller falls through)", () => {
    const noHelpers = { boxNumberIdx: null, unboxNumberIdx: null };
    expect(coercionPlan(f64, ext, noHelpers)).toBeNull();
    expect(coercionPlan(ext, f64, noHelpers)).toBeNull();
    // ref → f64 with no unbox helper is the only genuinely-lossy NaN fallback
    // (ToNumber of object without valueOf, §7.1.4).
    const refNoUnbox = coercionPlan(ref0, f64, noHelpers)!;
    expect(ops(refNoUnbox.instrs)).toEqual(["drop", "f64.const"]);
    expect(refNoUnbox.lossy).toBe(true);
  });

  it("funcref → externref is the lossy null fallback (separate type hierarchy)", () => {
    const p = coercionPlan({ kind: "funcref" }, ext, H)!;
    expect(ops(p.instrs)).toEqual(["drop", "ref.null.extern"]);
    expect(p.lossy).toBe(true);
  });

  it("ref/ref_null → ref/ref_null and guarded-cast rows are NOT owned (returns null)", () => {
    // Same-kind ref pairs (typeIdx-equality is the caller's concern).
    expect(coercionPlan(ref0, refNull0, H)).toBeNull();
    // externref → ref needs the expected struct typeIdx + guarded cast.
    expect(coercionPlan(ext, ref0, H)).toBeNull();
  });
});

describe("#1917 coercion-engine — end-to-end behavior is preserved (regression guard)", () => {
  async function run(src: string, standalone: boolean): Promise<unknown> {
    const r = await compile(src, standalone ? { fileName: "t.ts", target: "standalone" } : { fileName: "t.ts" });
    expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
    const importObj = standalone ? {} : (r.importObject ?? {});
    const { instance } = await WebAssembly.instantiate(r.binary, importObj as WebAssembly.Imports);
    return (instance.exports as { test(): unknown }).test();
  }

  const anyTernary = `export function test(): number {
  const a: any = 5; const b: any = 7; const cond = true;
  const x: number = (cond ? a : b);
  return x + 1;
}`;
  const anyIfAssign = `export function test(): number {
  let v: any;
  if (1 > 0) { v = 10; } else { v = 20; }
  const n: number = v;
  return n * 2;
}`;

  it("any-valued ternary coerced to number (host)", async () => expect(await run(anyTernary, false)).toBe(6));
  it("any-valued ternary coerced to number (standalone)", async () => expect(await run(anyTernary, true)).toBe(6));
  it("any assigned in if/else then used as number (host)", async () => expect(await run(anyIfAssign, false)).toBe(20));
  it("any assigned in if/else then used as number (standalone)", async () =>
    expect(await run(anyIfAssign, true)).toBe(20));
});
