// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3565 — restore three DESIGNED demote-to-legacy contracts that #3341/#3519
 * silently promoted to HARD `invariant` compile errors.
 *
 * The IR overlay's `formatIrPathFallbackDiagnostic` (src/codegen/index.ts) makes
 * any post-claim failure whose `outcome.kind === "invariant"` a hard compile
 * error — the fix #3341/#3519 introduced to catch real invalid-Wasm emission.
 * But three sites are DESIGNED demotes whose own code comments say they fall back
 * to legacy, and a plain `throw new Error` (or a verify error) at those sites was
 * being classified as the generic `unexpected-internal-throw` / `verifier-failure`
 * invariant → hard, breaking valid programs:
 *
 *   1. `lowerElementStore` TypedArray-view store (src/ir/from-ast.ts) — the
 *      per-view value conversions are legacy-only ("Demotes (clean throw →
 *      legacy) for: TypedArray-view receivers").
 *   2. `lowerElementAccess` slice-12 residual (src/ir/from-ast.ts) — an element
 *      READ on a receiver/index shape not yet in IR scope (e.g. `extern<C>[i]`).
 *   3. The verify.ts #1798 return-value gate — a return/early.return whose value
 *      type or arity would emit invalid Wasm; the gate exists PRECISELY to demote
 *      to legacy ("Flagging it here demotes the function to legacy ... instead of
 *      emitting an invalid module").
 *
 * These regressed silently for ~7 days (found via the same #3008 invisible-guard
 * audit that surfaced #680). This guard pins the demote behaviour AND — critically
 * — pins that a GENERIC invariant (a real builder↔finalize desync) STILL hard-fails,
 * so #3341's invalid-Wasm-catching purpose is preserved (no masking).
 *
 * Folded into the required guard suite (tests/guard-suite.json, #3552).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { asValueId, irVal, verifyIrFunction, type IrFunction, type IrInstr, type IrType } from "../src/ir/index.js";

const COMPILE_OPTS = {
  allowJs: true,
  sourceMap: false,
  emitWat: false,
  skipSemanticDiagnostics: true,
  fileName: "t.ts",
} as const;

/** The signature `formatIrPathFallbackDiagnostic` stamps on a HARD invariant. */
function hardIrErrors(r: { errors?: ReadonlyArray<{ severity?: string; message?: string }> }) {
  return (r.errors ?? []).filter(
    (e) => (e.severity === "error" || e.severity === undefined) && /IR-FALLBACK/.test(e.message ?? ""),
  );
}

describe("#3565 — restore IR designed demote-to-legacy contracts", () => {
  it("site 1: TypedArray element STORE in a claimed fn demotes to legacy (compiles, host + standalone)", async () => {
    const src = `export function putByte(buf: Uint8Array, i: number, v: number): void { buf[i] = v; }`;
    for (const target of [undefined, "standalone"] as const) {
      const r: any = await compile(src, { ...COMPILE_OPTS, ...(target ? { target } : {}) });
      expect(r.success).toBe(true);
      expect(hardIrErrors(r)).toHaveLength(0);
      // The demote path is actually exercised (not silently absent).
      const pc = (r.irPostClaimErrors ?? []).map((e: any) => e.message);
      expect(pc.some((m: string) => m.includes("element store on a TypedArray view"))).toBe(true);
    }
  });

  it("site 2: slice-12 element ACCESS (extern receiver) demotes to legacy (compiles)", async () => {
    const src =
      `declare class Coll { [i: number]: string; length: number; }\n` +
      `export function first(c: Coll): string { return c[0]; }`;
    const r: any = await compile(src, COMPILE_OPTS);
    expect(r.success).toBe(true);
    expect(hardIrErrors(r)).toHaveLength(0);
    const pc = (r.irPostClaimErrors ?? []).map((e: any) => e.message);
    expect(pc.some((m: string) => m.includes("element access on extern<Coll>") && m.includes("not in slice 12"))).toBe(
      true,
    );
  });

  it("site 4: compound-assign with a non-f64 RHS demotes to legacy AND runs (the issue-2079 shape)", async () => {
    // `s += v` where v is an externref yielded by a generator for-of — the f64
    // slot is fine but the RHS coercion is legacy-only. Must demote + run =3.
    const src =
      `function* g(){ yield 1; yield 2; return 3; }\n` +
      `export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`;
    const r: any = await compile(src, { ...COMPILE_OPTS, target: "standalone" });
    expect(r.success).toBe(true);
    expect(hardIrErrors(r)).toHaveLength(0);
    const pc = (r.irPostClaimErrors ?? []).map((e: any) => e.message);
    expect(pc.some((m: string) => m.includes("compound assign RHS must be f64"))).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    (instance.exports as any).__module_init?.();
    expect((instance.exports as any).test()).toBe(3);
  });

  it("site 3: verify #1798 return-type mismatch is tagged as a DESIGNED demote (demote:true)", () => {
    const STRING: IrType = { kind: "string" };
    const F64 = irVal({ kind: "f64" });
    // Declares a STRING result but returns an f64 const → the #1798 gate fires.
    const constF64: IrInstr = {
      kind: "const",
      value: { kind: "f64", value: 1 },
      result: asValueId(1),
      resultType: F64,
    };
    const fn: IrFunction = {
      name: "retTypeMismatch",
      params: [],
      resultTypes: [STRING],
      blocks: [
        {
          id: 0 as any,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [constF64],
          terminator: { kind: "return", values: [asValueId(1)] },
        },
      ],
      exported: false,
      valueCount: 64,
    };
    const errors = verifyIrFunction(fn);
    const gate = errors.find((e) => /not assignable to declared/.test(e.message));
    expect(gate).toBeDefined();
    // MUST carry the demote flag so integration classifies it `unsupported` (→ legacy),
    // not the hard `verifier-failure` invariant #3341/#3519 promoted.
    expect(gate!.demote).toBe(true);
  });

  it("masking guard: a GENUINE verify invariant is NOT tagged demote (stays a hard error)", () => {
    const F64 = irVal({ kind: "f64" });
    const I32 = irVal({ kind: "i32" });
    // f64.add over i32 operands — a real invalid-IR invariant (#1924 per-instr rule).
    const c1: IrInstr = { kind: "const", value: { kind: "i32", value: 1 }, result: asValueId(1), resultType: I32 };
    const c2: IrInstr = { kind: "const", value: { kind: "i32", value: 2 }, result: asValueId(2), resultType: I32 };
    const add: IrInstr = {
      kind: "binary",
      op: "f64.add",
      lhs: asValueId(1),
      rhs: asValueId(2),
      result: asValueId(3),
      resultType: F64,
    } as IrInstr;
    const fn: IrFunction = {
      name: "genuineInvariant",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: 0 as any,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [c1, c2, add],
          terminator: { kind: "return", values: [asValueId(3)] },
        },
      ],
      exported: false,
      valueCount: 64,
    };
    const errors = verifyIrFunction(fn);
    expect(errors.length).toBeGreaterThan(0);
    // No verify error here is a designed demote — every one stays a hard invariant.
    expect(errors.every((e) => e.demote !== true)).toBe(true);
  });

  it("masking guard (end-to-end): an injected build-time throw STILL hard-errors (invariant preserved)", async () => {
    // Bracket form (not `delete process.env.X`) to satisfy biome noDelete; a real
    // unset is required — the seam is a truthy check, so `= undefined` (string
    // "undefined") would leave it active.
    const FLAG = "JS2WASM_TEST_INJECT_IR_BUILD_THROW";
    const prev = process.env[FLAG];
    process.env[FLAG] = "1";
    try {
      const r: any = await compile(`export function test(): number { return 1; }`, COMPILE_OPTS);
      expect(r.success).toBe(false);
      expect(hardIrErrors(r).length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prev;
    }
  });
});
