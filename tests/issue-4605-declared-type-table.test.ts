// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4605 — module-level declared-type tables for the IR verifier.
 *
 * #4603 could only give `call` / `global.get` / `global.set` an intra-function
 * COHERENCE rule (two references to one binding must agree with each other),
 * because no declared-signature record existed anywhere the verifier could
 * reach. That catches the defect class but misses its most common shape: ONE
 * mistaken reference, perfectly coherent with itself. The load-bearing tests
 * below are exactly that shape — a single call site or a single `global.get`,
 * which the coherence rule cannot possibly flag and the declaration rule does.
 *
 * Method (#4070): every rule gets both halves, plus the third half this issue
 * needs — ABSENCE. The same negative fixture verified WITHOUT the tables must
 * be silent, because a table that is not there must never be read as
 * "undeclared, therefore wrong": absence is a conservative skip, and a verify
 * error demotes the function to the legacy compiler.
 */
import { describe, expect, it } from "vitest";
import {
  asBlockId,
  asValueId,
  irVal,
  verifyIrFunction,
  type IrBlock,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrValueId,
} from "../src/ir/index.js";
import {
  irBindingKey,
  irModuleDeclarations,
  type IrDeclaredSignature,
  type IrModuleDeclarations,
} from "../src/ir/declared-types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-4605");

const I32 = irVal({ kind: "i32" });
const F64 = irVal({ kind: "f64" });
const EXTERNREF = irVal({ kind: "externref" });

function constF64(id: number, value = 1): IrInstr {
  return { kind: "const", value: { kind: "f64", value }, result: asValueId(id), resultType: F64 };
}
function constI32(id: number, value = 1): IrInstr {
  return { kind: "const", value: { kind: "i32", value }, result: asValueId(id), resultType: I32 };
}

function block(id: number, instrs: IrInstr[]): IrBlock {
  return {
    id: asBlockId(id),
    blockArgs: [],
    blockArgTypes: [],
    instrs,
    terminator: { kind: "return", values: [] as IrValueId[] },
  };
}

function voidFn(name: string, instrs: IrInstr[]): IrFunction {
  return {
    ...irIdentities.next(name),
    params: [],
    resultTypes: [],
    blocks: [block(0, instrs)],
    exported: false,
    valueCount: 64,
  };
}

/** Messages only — the assertions are about which rule fired, not order. */
function verify(func: IrFunction, declarations?: IrModuleDeclarations): string[] {
  return verifyIrFunction(func, undefined, declarations).map((e) => e.message);
}

const runtimeFunc = (name: string) =>
  ({ kind: "func", name, binding: { kind: "runtime", symbol: name } }) as IrInstr extends {
    kind: "call";
    target: infer T;
  }
    ? T
    : never;

const supportGlobal = (name: string, bindingId: string) =>
  ({ kind: "global", name, binding: { kind: "support", bindingId } }) as IrInstr extends {
    kind: "global.get";
    target: infer T;
  }
    ? T
    : never;

const call = (id: number | null, target: string, args: number[], resultType: IrType | null): IrInstr =>
  ({
    kind: "call",
    target: runtimeFunc(target),
    args: args.map(asValueId),
    result: id === null ? null : asValueId(id),
    resultType,
  }) as IrInstr;

const globalGet = (id: number, name: string, bindingId: string, resultType: IrType): IrInstr => ({
  kind: "global.get",
  target: supportGlobal(name, `ir-binding:v1:global:${bindingId}`),
  result: asValueId(id),
  resultType,
});

const globalSet = (name: string, bindingId: string, value: number): IrInstr => ({
  kind: "global.set",
  target: supportGlobal(name, `ir-binding:v1:global:${bindingId}`),
  value: asValueId(value),
  result: null,
  resultType: null,
});

/** Declarations for one runtime callable, keyed the way the verifier keys it. */
function signatures(entries: readonly (readonly [string, IrDeclaredSignature])[]): IrModuleDeclarations {
  return {
    declaredSignatures: new Map(
      entries.map(([symbol, signature]) => [irBindingKey({ kind: "runtime", symbol })!, signature]),
    ),
  };
}

/** Declarations for one support global, keyed the way the verifier keys it. */
function globals(entries: readonly (readonly [string, IrType])[]): IrModuleDeclarations {
  return {
    declaredGlobals: new Map(
      entries.map(([bindingId, type]) => [
        irBindingKey({ kind: "support", bindingId: `ir-binding:v1:global:${bindingId}` })!,
        type,
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// The key is the shared vocabulary
// ---------------------------------------------------------------------------

describe("#4605 irBindingKey — one key function for producer and verifier", () => {
  it("keys each binding discriminant by its structural id, never by the debug name", () => {
    expect(irBindingKey({ kind: "runtime", symbol: "__helper" })).toBe("runtime:__helper");
    expect(irBindingKey({ kind: "unit", unitId: "u1" })).toBe("unit:u1");
    expect(irBindingKey({ kind: "support", bindingId: "b1" })).toBe("support:b1");
    expect(irBindingKey({ kind: "import", module: "env", field: "log" })).toBe("import:env:log");
  });

  it("returns null for a malformed binding, which is the verifier's skip signal", () => {
    expect(irBindingKey(null)).toBeNull();
    expect(irBindingKey({ noKind: true })).toBeNull();
    expect(irBindingKey({ kind: "runtime" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// call — the gap #4603 recorded and this issue closes
// ---------------------------------------------------------------------------

describe("#4605 call — one mistaken call site, coherent with itself", () => {
  const declared = signatures([["__h", { params: [F64], result: F64 }]]);

  it("accepts a lone call that matches the declaration", () => {
    expect(verify(voidFn("callOk", [constF64(1), call(2, "__h", [1], F64)]), declared)).toEqual([]);
  });

  it("rejects a lone call whose arity contradicts the declaration", () => {
    expect(verify(voidFn("callBadArity", [call(2, "__h", [], F64)]), declared)).toContain(
      "call __h passes 0 argument(s) but the module declares 1 parameter(s)",
    );
  });

  it("rejects a lone call whose result carrier contradicts the declaration", () => {
    expect(verify(voidFn("callBadResult", [constF64(1), call(2, "__h", [1], I32)]), declared)).toContain(
      "call __h resultType i32 contradicts the module-declared result f64",
    );
  });

  it("is silent on the SAME fixtures without the table — this is the whole gap", () => {
    // Neither of the two negatives above has a second reference to `__h`, so
    // #4603's coherence rule has nothing to compare against and reports
    // nothing. That is the defect shape #4605 exists to catch.
    expect(verify(voidFn("callBadArityNoDecl", [call(2, "__h", [], F64)]))).toEqual([]);
    expect(verify(voidFn("callBadResultNoDecl", [constF64(1), call(2, "__h", [1], I32)]))).toEqual([]);
  });

  it("skips a binding the table does not mention, and still applies coherence to it", () => {
    // `__other` is undeclared: no declaration error, but the #4603 coherence
    // rule is untouched and still catches the intra-function disagreement.
    const fn = voidFn("mixed", [constF64(1), call(2, "__other", [1], F64), call(3, "__other", [], F64)]);
    expect(verify(fn, declared)).toEqual(["call __other arity 0 disagrees with 1 used elsewhere in this function"]);
  });

  it("skips the result comparison when either carrier is undeclared or non-val", () => {
    const voidCallee = signatures([["__v", { params: [], result: null }]]);
    expect(verify(voidFn("voidCallee", [call(1, "__v", [], EXTERNREF)]), voidCallee)).toEqual([]);
    expect(verify(voidFn("noResultType", [call(null, "__v", [], null)]), voidCallee)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// global.get / global.set
// ---------------------------------------------------------------------------

describe("#4605 global.get / global.set — matched against the declared IrType", () => {
  const declared = globals([["b1", F64]]);

  it("accepts a lone get and a lone set on the declared carrier", () => {
    expect(verify(voidFn("globalOk", [globalGet(1, "g", "b1", F64)]), declared)).toEqual([]);
    expect(verify(voidFn("globalSetOk", [constF64(1), globalSet("g", "b1", 1)]), declared)).toEqual([]);
  });

  it("rejects a lone get whose carrier contradicts the declaration", () => {
    expect(verify(voidFn("globalBadGet", [globalGet(1, "g", "b1", I32)]), declared)).toContain(
      "global.get g carrier i32 contradicts the module-declared f64",
    );
  });

  it("rejects a lone set whose value carrier contradicts the declaration", () => {
    expect(verify(voidFn("globalBadSet", [constI32(1), globalSet("g", "b1", 1)]), declared)).toContain(
      "global.set g carrier i32 contradicts the module-declared f64",
    );
  });

  it("is silent on the SAME fixtures without the table", () => {
    expect(verify(voidFn("globalBadGetNoDecl", [globalGet(1, "g", "b1", I32)]))).toEqual([]);
    expect(verify(voidFn("globalBadSetNoDecl", [constI32(1), globalSet("g", "b1", 1)]))).toEqual([]);
  });

  it("leaves an undeclared global to the #4603 coherence rule", () => {
    const fn = voidFn("otherGlobal", [globalGet(1, "h", "b2", F64), constI32(2), globalSet("h", "b2", 2)]);
    expect(verify(fn, declared)).toEqual([
      "global.set h carrier i32 disagrees with f64 used by global.get elsewhere in this function",
    ]);
  });
});

// ---------------------------------------------------------------------------
// irModuleDeclarations — the producer side
// ---------------------------------------------------------------------------

describe("#4605 irModuleDeclarations — every function declares its own unit binding", () => {
  const sigFn = (name: string, params: IrType[], resultTypes: IrType[], extra?: Partial<IrFunction>): IrFunction => ({
    ...irIdentities.next(name),
    params: params.map((type, i) => ({ value: asValueId(i), type, name: `p${i}` })),
    resultTypes,
    blocks: [block(0, [])],
    exported: false,
    valueCount: 64,
    ...extra,
  });

  it("derives params and the first result type, keyed by the unit binding", () => {
    const fn = sigFn("add", [F64, F64], [F64]);
    const declarations = irModuleDeclarations({ functions: [fn] });
    const entry = declarations.declaredSignatures?.get(irBindingKey({ kind: "unit", unitId: fn.unitId })!);
    expect(entry).toEqual({ params: [F64, F64], result: F64 });
  });

  it("declares a void function's result as null", () => {
    const fn = sigFn("sideEffect", [I32], []);
    const declarations = irModuleDeclarations({ functions: [fn] });
    expect(declarations.declaredSignatures?.get(irBindingKey({ kind: "unit", unitId: fn.unitId })!)).toEqual({
      params: [I32],
      result: null,
    });
  });

  it("declares NO result for async and generator bodies, but still declares arity", () => {
    // Measured constraint, not caution: an async callee's `resultTypes` is the
    // AWAITED carrier (Promise<T> unwrapped), while a non-awaiting call site
    // legitimately receives the Promise as externref. Both are correct for the
    // same callee, so no single result carrier is declarable. Wiring this in
    // without the guard demoted three functions in
    // `website/playground/examples/js/async.ts`.
    for (const funcKind of ["async", "generator"] as const) {
      const fn = sigFn(`${funcKind}Body`, [F64], [F64], { funcKind });
      const entry = irModuleDeclarations({ functions: [fn] }).declaredSignatures?.get(
        irBindingKey({ kind: "unit", unitId: fn.unitId })!,
      );
      expect(entry, funcKind).toEqual({ params: [F64], result: null });
    }
  });

  it("lets an explicit table on the module win over the derived entry", () => {
    const fn = sigFn("overridden", [F64], [F64]);
    const key = irBindingKey({ kind: "unit", unitId: fn.unitId })!;
    const explicit: IrDeclaredSignature = { params: [I32, I32], result: I32 };
    const declarations = irModuleDeclarations({
      functions: [fn],
      declaredSignatures: new Map([[key, explicit]]),
    });
    expect(declarations.declaredSignatures?.get(key)).toEqual(explicit);
  });

  it("passes declaredGlobals through untouched — no function declares a global", () => {
    const table = globals([["b1", F64]]).declaredGlobals!;
    expect(irModuleDeclarations({ functions: [], declaredGlobals: table }).declaredGlobals).toBe(table);
    expect(irModuleDeclarations({ functions: [] }).declaredGlobals).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End to end: a module's own functions catch a bad call to one of them
// ---------------------------------------------------------------------------

describe("#4605 end to end — a call to a sibling unit is checked against that unit", () => {
  it("flags an arity contradiction against the callee's own declaration", () => {
    const callee: IrFunction = {
      ...irIdentities.next("callee"),
      params: [{ value: asValueId(0), type: F64, name: "x" }],
      resultTypes: [F64],
      blocks: [block(0, [])],
      exported: false,
      valueCount: 8,
    };
    const unitCall = (args: number[]): IrInstr =>
      ({
        kind: "call",
        target: { kind: "func", name: "callee", binding: { kind: "unit", unitId: callee.unitId } },
        args: args.map(asValueId),
        result: asValueId(9),
        resultType: F64,
      }) as IrInstr;
    const caller = voidFn("caller", [constF64(1), unitCall([1, 1])]);
    const declarations = irModuleDeclarations({ functions: [callee, caller] });

    expect(verify(caller, declarations)).toContain(
      "call callee passes 2 argument(s) but the module declares 1 parameter(s)",
    );
    expect(verify(caller)).toEqual([]);
  });
});
