// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4070 — the switches over the `IrInstr` union must be exhaustiveness-gated.
//
// The PRIMARY gate is at COMPILE time: each of the five switches now ends in
// `const _exhaustive: never = instr`, so adding a member to the `IrInstr` union
// without a matching case is a type error at that exact line. That half cannot
// be asserted from vitest — it is proven by adding a probe member to the union
// and observing `tsc` reject it; the measurement is recorded in
// plan/issues/4070-ir-verify-collectuses-never-exhaustiveness.md.
//
// What IS assertable here is the guard's RUNTIME arm, and it is the half that
// carries the real risk. Each `default` deliberately throws rather than
// returning a benign empty/unchanged value, because every one of these
// functions is consulted to decide something (which SSA values are live, which
// need a Wasm local, which ids to rewrite). A silently-permissive fallback
// would answer "nothing to see" precisely when the analysis cannot see — the
// unsound direction. This test pins that choice so a later "simplify" cannot
// quietly turn the throw back into `return []`.
//
// Only `renameInstrOperands` is exported; the twins in `src/ir/verify.ts`
// (`collectUses`), `src/ir/lower.ts` (`emitInstrTree`, `collectIrUses`) and
// `src/ir/passes/monomorphize.ts` (`collectUses`) are module-local by design,
// so they are covered by the compile-time half only.

import { describe, expect, it } from "vitest";

import { renameInstrOperands } from "../src/ir/passes/inline-small.js";
import type { IrInstr, IrValueId } from "../src/ir/nodes.js";

const v = (n: number): IrValueId => n as IrValueId;

describe("#4070 IrInstr exhaustiveness guards", () => {
  const rename = new Map<IrValueId, IrValueId>([[v(1), v(99)]]);

  it("positive control: a KNOWN instruction kind still renames its operands", () => {
    const binary = {
      kind: "binary",
      op: "f64.add",
      lhs: v(1),
      rhs: v(2),
      result: v(3),
      resultType: null,
    } as unknown as IrInstr;

    const out = renameInstrOperands(binary, rename) as unknown as {
      lhs: IrValueId;
      rhs: IrValueId;
      result: IrValueId;
    };

    // The renamed operand is redirected; the untouched one and the DEF are not
    // (this helper rewrites uses only — see its doc comment).
    expect(out.lhs).toBe(v(99));
    expect(out.rhs).toBe(v(2));
    expect(out.result).toBe(v(3));
  });

  it("an unrecognized instruction kind THROWS rather than passing through unchanged", () => {
    const bogus = { kind: "probe.not-in-union.4070", result: null, resultType: null } as unknown as IrInstr;

    expect(() => renameInstrOperands(bogus, rename)).toThrow(/renameInstrOperands has no case/);
  });

  it("the throw names the offending kind, so the diagnostic is actionable", () => {
    const bogus = { kind: "probe.not-in-union.4070", result: null, resultType: null } as unknown as IrInstr;

    expect(() => renameInstrOperands(bogus, rename)).toThrow(/probe\.not-in-union\.4070/);
  });

  it("the empty-rename fast path still short-circuits before the switch", () => {
    // `renameInstrOperands` returns early when there is nothing to rename.
    // That path predates this issue and must NOT start throwing on unknown
    // kinds — callers rely on it being a cheap no-op.
    const bogus = { kind: "probe.not-in-union.4070", result: null, resultType: null } as unknown as IrInstr;

    expect(renameInstrOperands(bogus, new Map())).toBe(bogus);
  });
});
