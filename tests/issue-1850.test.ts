// #1850 — IR verifier cross-block dominance (the former Phase-2 TODO).
//
// `verifyIrFunction` previously only checked use-before-def *within* a block.
// A use whose def lived in another block was either over-rejected (not a
// param/blockArg/local) or — if the def-block did not dominate the use-block —
// silently invisible. These tests pin the dominance contract:
//   - a cross-block use whose def-block dominates the use-block is accepted;
//   - a cross-block use reached by a non-dominating def is rejected with a
//     clear dominance-violation error;
//   - single-block functions (the common Phase-1 shape) are unaffected.
import { describe, expect, it } from "vitest";
import { formatIrPathFallbackDiagnostic } from "../src/codegen/index.js";
import { BytecodeEmitter, BytecodeTypeConverter } from "../src/ir/backend/bytecode-emitter.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import {
  asBlockId,
  asValueId,
  irVal,
  lowerIrFunctionBody,
  wasmValueTypeConverter,
  verifyIrFunction,
  verifyIrBackendLegality,
  type IrBlock,
  type IrFunction,
  type IrInstr,
  type IrLowerResolver,
  type IrType,
} from "../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-1850");

const I32 = irVal({ kind: "i32" });
const STRING: IrType = { kind: "string" };

function constI32(id: number, value: number): IrInstr {
  return { kind: "const", value: { kind: "i32", value }, result: asValueId(id), resultType: I32 };
}

function block(id: number, instrs: IrInstr[], terminator: IrBlock["terminator"], blockArgs: number[] = []): IrBlock {
  return {
    id: asBlockId(id),
    blockArgs: blockArgs.map(asValueId),
    blockArgTypes: blockArgs.map(() => I32),
    instrs,
    terminator,
  };
}

function minimalResolver(): IrLowerResolver {
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => 0,
  };
}

describe("#1850 — IR verifier cross-block dominance", () => {
  it("accepts a cross-block use whose def dominates the use (diamond join)", () => {
    // b0: v1 = const; br_if v1 ? b1 : b2
    // b1: br b3            b2: br b3
    // b3: return v1        (v1 defined in b0, which dominates b3 → OK)
    const v1 = asValueId(1);
    const fn: IrFunction = {
      ...irIdentities.next("domOk"),
      params: [],
      resultTypes: [I32],
      blocks: [
        block(0, [constI32(1, 7)], {
          kind: "br_if",
          condition: v1,
          ifTrue: { target: asBlockId(1), args: [] },
          ifFalse: { target: asBlockId(2), args: [] },
        }),
        block(1, [], { kind: "br", branch: { target: asBlockId(3), args: [] } }),
        block(2, [], { kind: "br", branch: { target: asBlockId(3), args: [] } }),
        block(3, [], { kind: "return", values: [v1] }),
      ],
      exported: false,
      valueCount: 8,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects a cross-block use reached by a non-dominating def", () => {
    // b0: v1 = const; br_if v1 ? b1 : b2
    // b1: v2 = const; br b3   (v2 defined only on the b1 path)
    // b2: br b3
    // b3: return v2           (v2's def b1 does NOT dominate b3 → violation)
    const v1 = asValueId(1);
    const v2 = asValueId(2);
    const fn: IrFunction = {
      ...irIdentities.next("domBad"),
      params: [],
      resultTypes: [I32],
      blocks: [
        block(0, [constI32(1, 7)], {
          kind: "br_if",
          condition: v1,
          ifTrue: { target: asBlockId(1), args: [] },
          ifFalse: { target: asBlockId(2), args: [] },
        }),
        block(1, [constI32(2, 9)], { kind: "br", branch: { target: asBlockId(3), args: [] } }),
        block(2, [], { kind: "br", branch: { target: asBlockId(3), args: [] } }),
        block(3, [], { kind: "return", values: [v2] }),
      ],
      exported: false,
      valueCount: 8,
    };
    const errors = verifyIrFunction(fn);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /not dominated by its def/.test(e.message) && e.block === 3)).toBe(true);
  });

  it("accepts a chained-dominator cross-block use (b0 → b1 → b2)", () => {
    // b0: v1 = const; br b1
    // b1: br b2
    // b2: return v1   (b0 dominates b2 transitively → OK)
    const v1 = asValueId(1);
    const fn: IrFunction = {
      ...irIdentities.next("domChain"),
      params: [],
      resultTypes: [I32],
      blocks: [
        block(0, [constI32(1, 5)], { kind: "br", branch: { target: asBlockId(1), args: [] } }),
        block(1, [], { kind: "br", branch: { target: asBlockId(2), args: [] } }),
        block(2, [], { kind: "return", values: [v1] }),
      ],
      exported: false,
      valueCount: 8,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects a terminator use of a value defined only in a successor", () => {
    // b0 branches on v2, but v2 is defined only after taking the b1 successor.
    // A successor never dominates its predecessor, so the terminator use is
    // rejected as a cross-block dominance violation.
    const v2 = asValueId(2);
    const fn: IrFunction = {
      ...irIdentities.next("useFromSuccessor"),
      params: [],
      resultTypes: [],
      blocks: [
        block(0, [], {
          kind: "br_if",
          condition: v2,
          ifTrue: { target: asBlockId(1), args: [] },
          ifFalse: { target: asBlockId(2), args: [] },
        }),
        block(1, [constI32(2, 3)], { kind: "return", values: [] }),
        block(2, [], { kind: "return", values: [] }),
      ],
      exported: false,
      valueCount: 8,
    };
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => /not dominated by its def/.test(e.message) && e.block === 0)).toBe(true);
  });

  it("leaves single-block functions unaffected (no false dominance errors)", () => {
    // b0: v1 = const; v2 = const; return v2  — all local, no cross-block uses.
    const v2 = asValueId(2);
    const fn: IrFunction = {
      ...irIdentities.next("singleBlock"),
      params: [],
      resultTypes: [I32],
      blocks: [block(0, [constI32(1, 1), constI32(2, 2)], { kind: "return", values: [v2] })],
      exported: false,
      valueCount: 8,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("accepts block-arg-threaded values across blocks (SSA phi replacement)", () => {
    // b0: v1 = const; br b1(v1)
    // b1(v2): return v2   — value crosses via block arg, not a free use.
    const v1 = asValueId(1);
    const v2 = asValueId(2);
    const fn: IrFunction = {
      ...irIdentities.next("blockArgThread"),
      params: [],
      resultTypes: [I32],
      blocks: [
        block(0, [constI32(1, 4)], { kind: "br", branch: { target: asBlockId(1), args: [v1] } }),
        block(1, [], { kind: "return", values: [v2] }, [2]),
      ],
      exported: false,
      valueCount: 8,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
  });
});

describe("#1850 — per-backend IR legality and hard verifier fallback", () => {
  it("accepts ordinary scalar IR for the WasmGC backend", () => {
    const v1 = asValueId(1);
    const fn: IrFunction = {
      ...irIdentities.next("wasmgcLegal"),
      params: [],
      resultTypes: [I32],
      blocks: [block(0, [constI32(1, 4)], { kind: "return", values: [v1] })],
      exported: false,
      valueCount: 2,
    };

    expect(verifyIrBackendLegality(fn, "wasmgc")).toEqual([]);
  });

  it("rejects string IR before lowering through the bytecode backend", () => {
    const v1 = asValueId(1);
    const fn: IrFunction = {
      ...irIdentities.next("bytecodeString"),
      params: [],
      resultTypes: [STRING],
      blocks: [
        block(0, [{ kind: "string.const", value: "x", result: v1, resultType: STRING }], {
          kind: "return",
          values: [v1],
        }),
      ],
      exported: false,
      valueCount: 2,
    };

    const errors = verifyIrBackendLegality(fn, "bytecode");
    expect(errors.some((e) => /instr string\.const/.test(e.message))).toBe(true);
    try {
      lowerIrFunctionBody(fn, minimalResolver(), new BytecodeEmitter(), new BytecodeTypeConverter());
      throw new Error("expected backend legality producer to throw");
    } catch (error) {
      expect(error).toMatchObject({
        name: "IrInvariantError",
        kind: "invariant",
        code: "backend-legality-failure",
        stage: "backend-legality",
      });
      expect(error).toHaveProperty("message", expect.stringMatching(/bytecode backend legality failed.*string\.const/));
    }
  });

  it("#2954: accepts a core-op (const) whole-function lowering through the linear boundary", () => {
    // #2954 opened the core-op families (const/binary/…/control-flow/call) on the
    // linear boundary — a numeric const function now lowers cleanly (byte-identical
    // to WasmGc). Cf. the divergent-family rejection test below.
    const v1 = asValueId(1);
    const fn: IrFunction = {
      ...irIdentities.next("linearConst"),
      params: [],
      resultTypes: [I32],
      blocks: [block(0, [constI32(1, 1)], { kind: "return", values: [v1] })],
      exported: false,
      valueCount: 2,
    };

    expect(verifyIrBackendLegality(fn, "linear")).toEqual([]);
    const resolver = minimalResolver();
    expect(() =>
      lowerIrFunctionBody(fn, resolver, new LinearEmitter(), wasmValueTypeConverter("linear", resolver, fn.name)),
    ).not.toThrow();
  });

  it("#2956 L2: accepts object.new after the linear-memory aggregate lowering lands", () => {
    // The linear resolver/emitter now carries object values as i32 arena
    // pointers and lowers fields through layout.ts offsets.
    const objInstr: IrInstr = {
      kind: "object.new",
      shape: { fields: [] },
      args: [],
      result: asValueId(1),
      resultType: { kind: "object", shape: { fields: [] } },
    } as unknown as IrInstr;
    const fn: IrFunction = {
      ...irIdentities.next("linearObject"),
      params: [],
      resultTypes: [I32],
      // object.new (v1, divergent) then a plain i32 const (v2) returned.
      blocks: [block(0, [objInstr, constI32(2, 0)], { kind: "return", values: [asValueId(2)] })],
      exported: false,
      valueCount: 3,
    };

    expect(verifyIrBackendLegality(fn, "linear")).toEqual([]);
  });

  it("promotes typed verifier invariants while leaving Unsupported builds as warnings", () => {
    const verifyDiag = formatIrPathFallbackDiagnostic({
      func: "claimed",
      message: "post-hygiene verify: duplicate SSA def",
      kind: "verify",
      outcome: {
        kind: "invariant",
        code: "verifier-failure",
        stage: "verify",
        detail: "post-hygiene verify: duplicate SSA def",
      },
    });
    expect(verifyDiag.severity).toBe("error");
    expect(verifyDiag.message).toMatch(/^Codegen error: IR path failed for claimed:/);

    const buildDiag = formatIrPathFallbackDiagnostic({
      func: "claimed",
      message: "ir/from-ast: feature not in slice",
      kind: "build",
      outcome: {
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "build",
        detail: "ir/from-ast: feature not in slice",
      },
    });
    expect(buildDiag.severity).toBe("warning");
    expect(buildDiag.message).toMatch(/^IR path failed for claimed:/);
  });
});
