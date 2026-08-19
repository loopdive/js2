// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 slice 1 — JsTag-carrying dynamic IrType: lattice + verifier rules +
// lowering contract. Everything here is producer-free (from-ast emits no
// dynamic IR yet, that's slice 2), so these tests hand-build IrFunctions the
// same way tests/ir/phase3c.test.ts does.

import { describe, expect, it } from "vitest";

import {
  asBlockId,
  asValueId,
  irDynamic,
  irTypeEquals,
  irVal,
  isDynamic,
  lowerIrFunctionToWasm,
  verifyIrFunction,
  type IrFunction,
  type IrLowerResolver,
  type IrType,
  type IrValueId,
} from "../src/ir/index.js";
import { JsTag, jsTagUnboxKind } from "../src/ir/js-tag.js";
// #3954 phase 1 — `IrType`'s dynamic leaf carries an opaque TagId, so a
// refinement is named through the JS tag domain, not the enum.
import { JS_TAG_IDS } from "../src/ir/js-tag-domain.js";
import { JsTag as JsTagReexport } from "../src/codegen/value-tags.js";
import type { FuncTypeDef, ValType } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-2949-ir-dynamic-type");

function id(n: number): IrValueId {
  return asValueId(n);
}

const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const DYN = irDynamic();

/** One-block function: params in, `instrs`, return `retVals` as `resultTypes`. */
function fn(
  name: string,
  params: { type: IrType; name: string }[],
  instrs: IrFunction["blocks"][number]["instrs"],
  retVals: IrValueId[],
  resultTypes: IrType[],
  valueCount: number,
): IrFunction {
  return {
    ...irIdentities.next(name),
    params: params.map((p, i) => ({ value: id(i), type: p.type, name: p.name })),
    resultTypes,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: retVals },
      },
    ],
    exported: false,
    valueCount,
  };
}

/** Minimal resolver whose dynamic carrier is externref (host-mode shape). */
function stubResolver(overrides: Partial<IrLowerResolver> = {}): {
  resolver: IrLowerResolver;
  internedTypes: FuncTypeDef[];
} {
  const internedTypes: FuncTypeDef[] = [];
  const resolver: IrLowerResolver = {
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: (t) => {
      internedTypes.push(t);
      return internedTypes.length - 1;
    },
    resolveDynamic: (): ValType => ({ kind: "externref" }),
    ...overrides,
  };
  return { resolver, internedTypes };
}

// ---------------------------------------------------------------------------
// 1. One canonical tag table (D4 rule)
// ---------------------------------------------------------------------------

describe("#2949 JsTag leaf module", () => {
  it("value-tags re-exports the SAME enum object as the js-tag leaf", () => {
    expect(JsTagReexport).toBe(JsTag);
    // Frozen tag order (append-only) — same assertions as issue-2104 tests.
    expect(JsTag.Null).toBe(0);
    expect(JsTag.Undefined).toBe(1);
    expect(JsTag.NumberI32).toBe(2);
    expect(JsTag.NumberF64).toBe(3);
    expect(JsTag.Boolean).toBe(4);
    expect(JsTag.String).toBe(5);
    expect(JsTag.Object).toBe(6);
    expect(JsTag.Function).toBe(7);
  });

  it("jsTagUnboxKind maps partitions to $AnyValue payload kinds", () => {
    expect(jsTagUnboxKind(JsTag.NumberI32)).toBe("i32");
    expect(jsTagUnboxKind(JsTag.Boolean)).toBe("i32");
    expect(jsTagUnboxKind(JsTag.NumberF64)).toBe("f64");
    expect(jsTagUnboxKind(JsTag.String)).toBe("ref");
    expect(jsTagUnboxKind(JsTag.Object)).toBe("ref");
    expect(jsTagUnboxKind(JsTag.Function)).toBe("ref");
    // Singleton partitions have no payload — unbox is invalid for them.
    expect(jsTagUnboxKind(JsTag.Null)).toBeNull();
    expect(jsTagUnboxKind(JsTag.Undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Lattice semantics
// ---------------------------------------------------------------------------

describe("#2949 dynamic IrType lattice", () => {
  it("irDynamic constructs bare and refined dynamics; isDynamic narrows", () => {
    expect(irDynamic()).toEqual({ kind: "dynamic" });
    expect(irDynamic(JS_TAG_IDS.String)).toEqual({ kind: "dynamic", tag: JsTag.String });
    expect(isDynamic(irDynamic())).toBe(true);
    expect(isDynamic(F64)).toBe(false);
  });

  it("irTypeEquals is EXACT on the tag refinement", () => {
    expect(irTypeEquals(irDynamic(), irDynamic())).toBe(true);
    expect(irTypeEquals(irDynamic(JS_TAG_IDS.String), irDynamic(JS_TAG_IDS.String))).toBe(true);
    // Different refinements are different types (joins must widen first).
    expect(irTypeEquals(irDynamic(JS_TAG_IDS.String), irDynamic(JS_TAG_IDS.Object))).toBe(false);
    // Refined vs bare are different types too.
    expect(irTypeEquals(irDynamic(JS_TAG_IDS.String), irDynamic())).toBe(false);
    // dynamic is not any val-kind, even the carrier's ValType.
    expect(irTypeEquals(irDynamic(), irVal({ kind: "externref" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Verifier rules R1–R4
// ---------------------------------------------------------------------------

describe("#2949 verifier rules for dynamic", () => {
  it("a dynamic identity function verifies clean (move-only use)", () => {
    const f = fn("dynId", [{ type: DYN, name: "x" }], [], [id(0)], [DYN], 1);
    expect(verifyIrFunction(f)).toEqual([]);
  });

  it("R1: box f64 → dynamic verifies clean", () => {
    const f = fn(
      "boxIt",
      [{ type: F64, name: "n" }],
      [{ kind: "box", value: id(0), toType: DYN, result: id(1), resultType: DYN }],
      [id(1)],
      [DYN],
      2,
    );
    expect(verifyIrFunction(f)).toEqual([]);
  });

  it("R1: re-boxing an already-dynamic value is rejected", () => {
    const f = fn(
      "reBox",
      [{ type: DYN, name: "x" }],
      [{ kind: "box", value: id(0), toType: DYN, result: id(1), resultType: DYN }],
      [id(1)],
      [DYN],
      2,
    );
    const errors = verifyIrFunction(f);
    expect(errors.some((e) => /already dynamic/.test(e.message))).toBe(true);
  });

  it("box to a val-kind target is still rejected (message mentions dynamic now)", () => {
    const f = fn(
      "badBox",
      [{ type: F64, name: "n" }],
      [{ kind: "box", value: id(0), toType: I32, result: id(1), resultType: I32 }],
      [id(1)],
      [I32],
      2,
    );
    const errors = verifyIrFunction(f);
    expect(errors.some((e) => /box target must be a union or dynamic/.test(e.message))).toBe(true);
  });

  it("R2: unbox on a dynamic operand requires tagId", () => {
    const f = fn(
      "noTagId",
      [{ type: DYN, name: "x" }],
      [{ kind: "unbox", value: id(0), tag: { kind: "f64" }, result: id(1), resultType: F64 }],
      [id(1)],
      [F64],
      2,
    );
    const errors = verifyIrFunction(f);
    expect(errors.some((e) => /requires tagId/.test(e.message))).toBe(true);
  });

  it("R2: unbox with a payload-less partition (Undefined) is rejected", () => {
    const f = fn(
      "unboxUndef",
      [{ type: DYN, name: "x" }],
      [{ kind: "unbox", value: id(0), tagId: JS_TAG_IDS.Undefined, result: id(1), resultType: F64 }],
      [id(1)],
      [F64],
      2,
    );
    const errors = verifyIrFunction(f);
    expect(errors.some((e) => /payload-less partition Undefined/.test(e.message))).toBe(true);
  });

  it("R2: unbox dynamic with consistent tagId+tag verifies clean; inconsistent is rejected", () => {
    const ok = fn(
      "unboxNum",
      [{ type: DYN, name: "x" }],
      [
        {
          kind: "unbox",
          value: id(0),
          tagId: JS_TAG_IDS.NumberF64,
          tag: { kind: "f64" },
          result: id(1),
          resultType: F64,
        },
      ],
      [id(1)],
      [F64],
      2,
    );
    expect(verifyIrFunction(ok)).toEqual([]);

    const bad = fn(
      "unboxNumBad",
      [{ type: DYN, name: "x" }],
      [
        {
          kind: "unbox",
          value: id(0),
          tagId: JS_TAG_IDS.NumberF64,
          tag: { kind: "i32" },
          result: id(1),
          resultType: F64,
        },
      ],
      [id(1)],
      [F64],
      2,
    );
    const errors = verifyIrFunction(bad);
    expect(errors.some((e) => /inconsistent with partition NumberF64/.test(e.message))).toBe(true);
  });

  it("R3: tag.test on dynamic accepts payload-less partitions (Null/Undefined)", () => {
    const f = fn(
      "isNull",
      [{ type: DYN, name: "x" }],
      [{ kind: "tag.test", value: id(0), tagId: JS_TAG_IDS.Null, result: id(1), resultType: I32 }],
      [id(1)],
      [I32],
      2,
    );
    expect(verifyIrFunction(f)).toEqual([]);
  });

  it("R3: tag.test on a union operand still requires the ValType tag", () => {
    const unionType: IrType = { kind: "union", members: [F64, I32] };
    const f = fn(
      "unionNoTag",
      [{ type: unionType, name: "v" }],
      [{ kind: "tag.test", value: id(0), result: id(1), resultType: I32 }],
      [id(1)],
      [I32],
      2,
    );
    const errors = verifyIrFunction(f);
    expect(errors.some((e) => /union operand requires a ValType tag/.test(e.message))).toBe(true);
  });

  it("union tag.test regression: the V1 path still verifies clean", () => {
    const unionType: IrType = { kind: "union", members: [F64, I32] };
    const f = fn(
      "discriminate",
      [{ type: unionType, name: "v" }],
      [{ kind: "tag.test", value: id(0), tag: { kind: "f64" }, result: id(1), resultType: I32 }],
      [id(1)],
      [I32],
      2,
    );
    expect(verifyIrFunction(f)).toEqual([]);
  });

  it("R4: a dynamic operand feeding a scalar binary op is rejected", () => {
    const f = fn(
      "addDyn",
      [
        { type: DYN, name: "x" },
        { type: F64, name: "y" },
      ],
      [{ kind: "binary", op: "f64.add", lhs: id(0), rhs: id(1), result: id(2), resultType: F64 }],
      [id(2)],
      [F64],
      3,
    );
    const errors = verifyIrFunction(f);
    expect(errors.some((e) => /lhs is dynamic — scalar ops require an explicit unbox/.test(e.message))).toBe(true);
  });

  it("R4: a dynamic operand feeding a unary op is rejected", () => {
    const f = fn(
      "negDyn",
      [{ type: DYN, name: "x" }],
      [{ kind: "unary", op: "f64.neg", rand: id(0), result: id(1), resultType: F64 }],
      [id(1)],
      [F64],
      2,
    );
    const errors = verifyIrFunction(f);
    expect(errors.some((e) => /operand is dynamic — requires an explicit unbox/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Lowering contract
// ---------------------------------------------------------------------------

describe("#2949 lowering contract for dynamic", () => {
  it("a dynamic identity function lowers through resolveDynamic's carrier", () => {
    const f = fn("dynId", [{ type: DYN, name: "x" }], [], [id(0)], [DYN], 1);
    f.blocks[0]!.terminator = { kind: "return", values: [id(0)] };
    const { resolver, internedTypes } = stubResolver();
    const { func } = lowerIrFunctionToWasm(f, resolver);
    // The interned func type maps both the param and the result to the
    // carrier ValType the resolver chose (externref in this stub).
    expect(internedTypes).toHaveLength(1);
    expect(internedTypes[0]!.params).toEqual([{ kind: "externref" }]);
    expect(internedTypes[0]!.results).toEqual([{ kind: "externref" }]);
    // Body is a plain move: local.get of the param, then return.
    expect(func.body.map((op) => op.op)).toEqual(["local.get", "return"]);
  });

  it("lowering a dynamic-typed function without resolveDynamic fails loudly", () => {
    const f = fn("dynId", [{ type: DYN, name: "x" }], [], [id(0)], [DYN], 1);
    const { resolver } = stubResolver({ resolveDynamic: undefined });
    expect(() => lowerIrFunctionToWasm(f, resolver)).toThrow(/resolver cannot lower dynamic IrType/);
  });

  it("box-to-dynamic without resolveDynamicLowering fails loudly (slice 3 landed the arms)", () => {
    // Slice 1 staged a "lands in #2949 slice 3" error here; slice 3 replaced
    // it with the real lowering, so the failure mode for a resolver without
    // dynamic op support is now the missing-resolver contract error (same
    // shape as the resolveDynamic one above). The positive lowering paths
    // live in tests/issue-2949-slice3-dynamic-lowering.test.ts.
    const f = fn(
      "boxIt",
      [{ type: F64, name: "n" }],
      [{ kind: "box", value: id(0), toType: DYN, result: id(1), resultType: DYN }],
      [id(1)],
      [DYN],
      2,
    );
    const { resolver } = stubResolver();
    expect(() => lowerIrFunctionToWasm(f, resolver)).toThrow(/resolveDynamicLowering missing/);
  });
});
