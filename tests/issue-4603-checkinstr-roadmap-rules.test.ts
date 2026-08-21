// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4603 — real type rules for the 17 kinds #4523's triage put in the
 * `rule-worth-adding` bucket.
 *
 * Method (#4070): every rule gets BOTH halves.
 *   - a POSITIVE fixture — IR shaped the way real producers shape it, which
 *     must verify clean. This is the half that matters: a verify error demotes
 *     the function to the legacy path, so an over-strict rule silently loses IR
 *     coverage rather than failing loudly.
 *   - a NEGATIVE fixture — synthetic IR that violates exactly one rule, which
 *     must produce that rule's specific message. Without it a rule that never
 *     fires is indistinguishable from a rule that is not wired up.
 *
 * Three of the seventeen did NOT get a `checkInstr` arm of the shape #4523
 * sketched, and the reason is pinned here rather than left to the skip text:
 * `call` / `global.get` / `global.set` cannot be matched against a declared
 * signature, because the IR resolves both lazily through symbolic refs and
 * NEITHER `IrModule` (which holds only `functions`) nor `IrFunction` carries a
 * declared-type table. What is in scope is every other reference to the same
 * binding in the same function, so those three get an intra-function COHERENCE
 * rule instead. `early.return` needed no new arm at all — see the
 * `TYPE_RULE_STATUS` entry.
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
import { createTestIrClassId, createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-4603");

const I32 = irVal({ kind: "i32" });
const F64 = irVal({ kind: "f64" });
const I64 = irVal({ kind: "i64" });
const EXTERNREF = irVal({ kind: "externref" });

function constI32(id: number, value = 1, resultType: IrType = I32): IrInstr {
  return { kind: "const", value: { kind: "i32", value }, result: asValueId(id), resultType };
}
function constF64(id: number, value = 1, resultType: IrType = F64): IrInstr {
  return { kind: "const", value: { kind: "f64", value }, result: asValueId(id), resultType };
}

function block(id: number, instrs: IrInstr[], terminator?: IrBlock["terminator"]): IrBlock {
  return {
    id: asBlockId(id),
    blockArgs: [],
    blockArgTypes: [],
    instrs,
    terminator: terminator ?? { kind: "return", values: [] as IrValueId[] },
  };
}

/** A void single-block function — the default shell for statement-level instrs. */
function voidFn(name: string, instrs: IrInstr[], slots: number = 0): IrFunction {
  return {
    ...irIdentities.next(name),
    params: [],
    resultTypes: [],
    blocks: [block(0, instrs)],
    exported: false,
    valueCount: 64,
    ...(slots > 0
      ? {
          slots: Array.from({ length: slots }, (_unused, i) => ({
            name: `s${i}`,
            type: EXTERNREF,
          })) as IrFunction["slots"],
        }
      : {}),
  };
}

/** Messages only — every assertion below is about which rule fired, not order. */
function verify(func: IrFunction): string[] {
  return verifyIrFunction(func).map((e) => e.message);
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

// ---------------------------------------------------------------------------
// const
// ---------------------------------------------------------------------------

describe("#4603 const — resultType must match the literal's carrier", () => {
  it("accepts each literal on its own carrier (incl. bool on i32)", () => {
    expect(
      verify(
        voidFn("constOk", [
          constI32(1),
          constF64(2),
          { kind: "const", value: { kind: "i64", value: 7n }, result: asValueId(3), resultType: I64 },
          // `emitConstInstr` lowers bool to `i32.const 0/1`; the boolean brand
          // rides on the same i32 carrier.
          {
            kind: "const",
            value: { kind: "bool", value: true },
            result: asValueId(4),
            resultType: { kind: "val", val: { kind: "i32", boolean: true } },
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("skips reference-shaped literals (null carries its own ty; undefined never materializes)", () => {
    expect(
      verify(
        voidFn("constRef", [
          { kind: "const", value: { kind: "null", ty: EXTERNREF }, result: asValueId(1), resultType: EXTERNREF },
        ]),
      ),
    ).toEqual([]);
  });

  it("rejects an f64 literal annotated as i32", () => {
    const messages = verify(voidFn("constBad", [constF64(1, 1, I32)]));
    expect(messages).toContain("const f64 resultType must be f64, got i32");
  });

  it("rejects an i32 literal annotated as f64", () => {
    expect(verify(voidFn("constBad2", [constI32(1, 1, F64)]))).toContain("const i32 resultType must be i32, got f64");
  });
});

// ---------------------------------------------------------------------------
// select / if
// ---------------------------------------------------------------------------

function select(id: number, cond: number, whenTrue: number, whenFalse: number, resultType: IrType): IrInstr {
  return {
    kind: "select",
    condition: asValueId(cond),
    whenTrue: asValueId(whenTrue),
    whenFalse: asValueId(whenFalse),
    result: asValueId(id),
    resultType,
  };
}

describe("#4603 select — i32 condition, arms agreeing with resultType", () => {
  it("accepts an f64 select over an i32 condition", () => {
    expect(verify(voidFn("selOk", [constI32(1), constF64(2), constF64(3), select(4, 1, 2, 3, F64)]))).toEqual([]);
  });

  it("rejects an f64 condition", () => {
    expect(verify(voidFn("selBadCond", [constF64(1), constF64(2), constF64(3), select(4, 1, 2, 3, F64)]))).toContain(
      "select condition must be i32, got f64",
    );
  });

  it("rejects an arm whose carrier disagrees with resultType", () => {
    const messages = verify(voidFn("selBadArm", [constI32(1), constF64(2), constI32(3), select(4, 1, 2, 3, F64)]));
    expect(messages.some((m) => m.startsWith("select whenFalse must be f64 (the resultType), got i32"))).toBe(true);
  });
});

function ifExpr(id: number, cond: number, thenValue: number, elseValue: number, resultType: IrType): IrInstr {
  return {
    kind: "if",
    cond: asValueId(cond),
    then: [],
    thenValue: asValueId(thenValue),
    else: [],
    elseValue: asValueId(elseValue),
    result: asValueId(id),
    resultType,
  };
}

describe("#4603 if — the value dual of if.stmt's cond rule", () => {
  it("accepts an f64 if/else over an i32 cond", () => {
    expect(verify(voidFn("ifOk", [constI32(1), constF64(2), constF64(3), ifExpr(4, 1, 2, 3, F64)]))).toEqual([]);
  });

  it("rejects a non-i32 cond", () => {
    expect(verify(voidFn("ifBadCond", [constF64(1), constF64(2), constF64(3), ifExpr(4, 1, 2, 3, F64)]))).toContain(
      "if cond must be i32, got f64",
    );
  });

  it("rejects an arm carrier that disagrees with resultType", () => {
    const messages = verify(voidFn("ifBadArm", [constI32(1), constI32(2), constF64(3), ifExpr(4, 1, 2, 3, F64)]));
    expect(messages.some((m) => m.startsWith("if thenValue must be f64 (the resultType), got i32"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// object.new / closure.new
// ---------------------------------------------------------------------------

function objectNew(id: number, fields: { name: string; type: IrType }[], values: number[]): IrInstr {
  const shape = { fields };
  return {
    kind: "object.new",
    shape,
    values: values.map(asValueId),
    result: asValueId(id),
    resultType: { kind: "object", shape },
  };
}

describe("#4603 object.new — values parallel to shape.fields", () => {
  it("accepts matching arity and per-field carriers", () => {
    expect(
      verify(
        voidFn("objOk", [
          constF64(1),
          constI32(2),
          objectNew(
            3,
            [
              { name: "a", type: F64 },
              { name: "b", type: I32 },
            ],
            [1, 2],
          ),
        ]),
      ),
    ).toEqual([]);
  });

  it("rejects an arity mismatch", () => {
    expect(verify(voidFn("objBadArity", [constF64(1), objectNew(3, [{ name: "a", type: F64 }], [1, 1])]))).toContain(
      "object.new value count 2 != shape field count 1",
    );
  });

  it("rejects a value whose carrier disagrees with the field type", () => {
    expect(verify(voidFn("objBadField", [constI32(1), objectNew(3, [{ name: "a", type: F64 }], [1])]))).toContain(
      "object.new value for field 'a' must be f64, got i32",
    );
  });
});

function closureNew(id: number, captureFieldTypes: IrType[], captures: number[]): IrInstr {
  const signature = { params: [] as IrType[], returnType: null };
  return {
    kind: "closure.new",
    liftedFunc: runtimeFunc("__lifted"),
    signature,
    captureFieldTypes,
    captures: captures.map(asValueId),
    result: asValueId(id),
    resultType: { kind: "closure", signature },
  } as IrInstr;
}

describe("#4603 closure.new — captures parallel to captureFieldTypes", () => {
  it("accepts matching arity and carriers", () => {
    expect(verify(voidFn("cloOk", [constF64(1), closureNew(2, [F64], [1])]))).toEqual([]);
  });

  it("rejects an arity mismatch", () => {
    expect(verify(voidFn("cloBadArity", [constF64(1), closureNew(2, [F64, I32], [1])]))).toContain(
      "closure.new capture count 1 != captureFieldTypes count 2",
    );
  });

  it("rejects a capture whose carrier disagrees with its field type", () => {
    expect(verify(voidFn("cloBadType", [constI32(1), closureNew(2, [F64], [1])]))).toContain(
      "closure.new capture 0 must be f64, got i32",
    );
  });
});

// ---------------------------------------------------------------------------
// class.new / class.super_init / class.instanceof
// ---------------------------------------------------------------------------

function classShape(className: string, constructorParams: IrType[], ordinal = 0) {
  return {
    classId: createTestIrClassId("issue-4603", ordinal),
    className,
    fields: [],
    methods: [],
    constructorParams,
  };
}

describe("#4603 class.new / class.super_init — args vs the shape's constructor signature", () => {
  it("accepts matching arity and carriers", () => {
    const shape = classShape("Point", [F64, F64]);
    const instr: IrInstr = {
      kind: "class.new",
      shape,
      args: [asValueId(1), asValueId(2)],
      result: asValueId(3),
      resultType: { kind: "class", shape },
    };
    expect(verify(voidFn("classOk", [constF64(1), constF64(2), instr]))).toEqual([]);
  });

  it("rejects a class.new arity mismatch and names the class", () => {
    const shape = classShape("Point", [F64, F64]);
    const instr: IrInstr = {
      kind: "class.new",
      shape,
      args: [asValueId(1)],
      result: asValueId(3),
      resultType: { kind: "class", shape },
    };
    expect(verify(voidFn("classBadArity", [constF64(1), instr]))).toContain(
      "class.new arg count 1 != constructor arity 2 (class Point)",
    );
  });

  it("rejects a class.super_init arg whose carrier disagrees with the parent ctor param", () => {
    const parentShape = classShape("Base", [F64], 1);
    const selfShape = classShape("Derived", [], 2);
    const instr: IrInstr = {
      kind: "class.super_init",
      parentShape,
      self: asValueId(1),
      args: [asValueId(2)],
      result: null,
      resultType: null,
    };
    const fn: IrFunction = {
      ...irIdentities.next("superInitBad"),
      params: [{ name: "self", value: asValueId(1), type: { kind: "class", shape: selfShape } }],
      resultTypes: [],
      blocks: [block(0, [constI32(2), instr])],
      exported: false,
      valueCount: 64,
    };
    expect(verify(fn)).toContain("class.super_init arg 0 must be f64, got i32 (class Base)");
  });

  it("class.instanceof must produce the i32 boolean carrier", () => {
    const shape = classShape("Point", [], 3);
    const ok: IrInstr = {
      kind: "class.instanceof",
      value: asValueId(1),
      targetShape: shape,
      result: asValueId(2),
      resultType: I32,
    };
    const bad: IrInstr = { ...ok, result: asValueId(3), resultType: F64 } as IrInstr;
    const shell = (name: string, instr: IrInstr): IrFunction => ({
      ...irIdentities.next(name),
      params: [{ name: "v", value: asValueId(1), type: { kind: "class", shape } }],
      resultTypes: [],
      blocks: [block(0, [instr])],
      exported: false,
      valueCount: 64,
    });
    expect(verify(shell("instOk", ok))).toEqual([]);
    expect(verify(shell("instBad", bad))).toContain("class.instanceof resultType must be i32 (bool), got f64");
  });
});

// ---------------------------------------------------------------------------
// coerce.to_externref / iter.done
// ---------------------------------------------------------------------------

describe("#4603 coerce.to_externref — externref, or the callable spelling", () => {
  const coerce = (id: number, resultType: IrType): IrInstr => ({
    kind: "coerce.to_externref",
    value: asValueId(1),
    result: asValueId(id),
    resultType,
  });

  const shell = (name: string, instr: IrInstr): IrFunction => ({
    ...irIdentities.next(name),
    params: [{ name: "v", value: asValueId(1), type: EXTERNREF }],
    resultTypes: [],
    blocks: [block(0, [instr])],
    exported: false,
    valueCount: 64,
  });

  it("accepts the ordinary externref result", () => {
    expect(verify(shell("coerceOk", coerce(2, EXTERNREF)))).toEqual([]);
  });

  it("accepts the closure-boundary pack's callable result (it also lowers to externref)", () => {
    expect(
      verify(shell("coerceCallable", coerce(2, { kind: "callable", signature: { params: [], returnType: null } }))),
    ).toEqual([]);
  });

  it("rejects a scalar result", () => {
    expect(verify(shell("coerceBad", coerce(2, F64)))).toContain(
      "coerce.to_externref resultType must be externref or a callable, got f64",
    );
  });
});

describe("#4603 iter.done — the done flag rides the i32 carrier", () => {
  const shell = (name: string, resultType: IrType): IrFunction => ({
    ...irIdentities.next(name),
    params: [{ name: "r", value: asValueId(1), type: EXTERNREF }],
    resultTypes: [],
    blocks: [block(0, [{ kind: "iter.done", resultObj: asValueId(1), result: asValueId(2), resultType }])],
    exported: false,
    valueCount: 64,
  });

  it("accepts i32", () => {
    expect(verify(shell("iterDoneOk", I32))).toEqual([]);
  });

  it("rejects externref", () => {
    expect(verify(shell("iterDoneBad", EXTERNREF))).toContain("iter.done resultType must be i32 (bool), got externref");
  });
});

// ---------------------------------------------------------------------------
// forof.vec / forof.iter / forof.string
// ---------------------------------------------------------------------------

describe("#4603 forof.* — loop-state slot indices must be in bounds", () => {
  const vecFn = (name: string, slots: number, elementType: IrType = F64): IrFunction => ({
    ...irIdentities.next(name),
    params: [{ name: "v", value: asValueId(1), type: { kind: "vec", elementType: F64, nullable: false } }],
    resultTypes: [],
    blocks: [
      block(0, [
        {
          kind: "forof.vec",
          vec: asValueId(1),
          elementType,
          counterSlot: 0,
          lengthSlot: 1,
          vecSlot: 2,
          dataSlot: 3,
          elementSlot: 4,
          body: [],
          result: null,
          resultType: null,
        },
      ]),
    ],
    exported: false,
    valueCount: 64,
    slots: Array.from({ length: slots }, (_u, i) => ({ name: `s${i}`, type: EXTERNREF })) as IrFunction["slots"],
  });

  it("accepts a forof.vec whose five slots are all declared", () => {
    expect(verify(vecFn("forofVecOk", 5))).toEqual([]);
  });

  it("rejects a forof.vec slot past the end of func.slots", () => {
    const messages = verify(vecFn("forofVecBadSlot", 4));
    expect(messages).toContain("forof.vec elementSlot 4 out of bounds (function has 4 slots)");
  });

  it("rejects a forof.vec elementType that disagrees with the vec's element type", () => {
    expect(verify(vecFn("forofVecBadElem", 5, I32))).toContain(
      "forof.vec elementType i32 does not match the vec's element type f64",
    );
  });

  it("rejects an out-of-bounds forof.iter slot", () => {
    const fn: IrFunction = {
      ...irIdentities.next("forofIterBad"),
      params: [{ name: "it", value: asValueId(1), type: EXTERNREF }],
      resultTypes: [],
      blocks: [
        block(0, [
          {
            kind: "forof.iter",
            iterable: asValueId(1),
            iterSlot: 0,
            resultSlot: 1,
            elementSlot: 9,
            body: [],
            result: null,
            resultType: null,
          },
        ]),
      ],
      exported: false,
      valueCount: 64,
      slots: Array.from({ length: 3 }, (_u, i) => ({ name: `s${i}`, type: EXTERNREF })) as IrFunction["slots"],
    };
    expect(verify(fn)).toContain("forof.iter elementSlot 9 out of bounds (function has 3 slots)");
  });

  it("rejects an out-of-bounds forof.string slot", () => {
    const fn: IrFunction = {
      ...irIdentities.next("forofStringBad"),
      params: [{ name: "s", value: asValueId(1), type: { kind: "string" } }],
      resultTypes: [],
      blocks: [
        block(0, [
          {
            kind: "forof.string",
            str: asValueId(1),
            counterSlot: 0,
            lengthSlot: 1,
            strSlot: 2,
            elementSlot: 7,
            body: [],
            result: null,
            resultType: null,
          },
        ]),
      ],
      exported: false,
      valueCount: 64,
      slots: Array.from({ length: 4 }, (_u, i) => ({ name: `s${i}`, type: EXTERNREF })) as IrFunction["slots"],
    };
    expect(verify(fn)).toContain("forof.string elementSlot 7 out of bounds (function has 4 slots)");
  });
});

// ---------------------------------------------------------------------------
// call / global.get / global.set — intra-function coherence
// ---------------------------------------------------------------------------

describe("#4603 call — references to one binding must agree within a function", () => {
  const call = (id: number | null, target: string, args: number[], resultType: IrType | null): IrInstr =>
    ({
      kind: "call",
      target: runtimeFunc(target),
      args: args.map(asValueId),
      result: id === null ? null : asValueId(id),
      resultType,
    }) as IrInstr;

  it("accepts two consistent calls to the same runtime symbol", () => {
    expect(
      verify(voidFn("callOk", [constF64(1), call(2, "__helper", [1], F64), call(3, "__helper", [1], F64)])),
    ).toEqual([]);
  });

  it("accepts calls to two DIFFERENT symbols with different shapes", () => {
    expect(verify(voidFn("callTwo", [constF64(1), call(2, "__a", [1], F64), call(3, "__b", [], I32)]))).toEqual([]);
  });

  it("rejects an arity disagreement on one binding", () => {
    expect(verify(voidFn("callBadArity", [constF64(1), call(2, "__h", [1], F64), call(3, "__h", [], F64)]))).toContain(
      "call __h arity 0 disagrees with 1 used elsewhere in this function",
    );
  });

  it("rejects a result-carrier disagreement on one binding", () => {
    expect(
      verify(voidFn("callBadResult", [constF64(1), call(2, "__h", [1], F64), call(3, "__h", [1], I32)])),
    ).toContain("call __h resultType i32 disagrees with f64 used elsewhere in this function");
  });
});

describe("#4603 global.get / global.set — one binding, one carrier per function", () => {
  const get = (id: number, name: string, bindingId: string, resultType: IrType): IrInstr => ({
    kind: "global.get",
    target: supportGlobal(name, `ir-binding:v1:global:${bindingId}`),
    result: asValueId(id),
    resultType,
  });
  const set = (name: string, bindingId: string, value: number): IrInstr => ({
    kind: "global.set",
    target: supportGlobal(name, `ir-binding:v1:global:${bindingId}`),
    value: asValueId(value),
    result: null,
    resultType: null,
  });

  it("accepts a get and a set that agree", () => {
    expect(verify(voidFn("globalOk", [get(1, "g", "b1", F64), constF64(2), set("g", "b1", 2)]))).toEqual([]);
  });

  it("accepts two DIFFERENT globals with different carriers", () => {
    expect(verify(voidFn("globalTwo", [get(1, "g", "b1", F64), get(2, "h", "b2", I32)]))).toEqual([]);
  });

  it("rejects a set whose value carrier contradicts an earlier get", () => {
    expect(verify(voidFn("globalBad", [get(1, "g", "b1", F64), constI32(2), set("g", "b1", 2)]))).toContain(
      "global.set g carrier i32 disagrees with f64 used by global.get elsewhere in this function",
    );
  });

  it("rejects two gets of one binding that disagree", () => {
    expect(verify(voidFn("globalBadGets", [get(1, "g", "b1", F64), get(2, "g", "b1", I32)]))).toContain(
      "global.get g carrier i32 disagrees with f64 used by global.get elsewhere in this function",
    );
  });
});

// ---------------------------------------------------------------------------
// early.return — the 17th kind, which needed no new arm
// ---------------------------------------------------------------------------

describe("#4603 early.return — already ruled in verifyIrFunction (#1798/#2856)", () => {
  it("still reports the arity/assignability rule, and reports it exactly once", () => {
    const fn: IrFunction = {
      ...irIdentities.next("earlyReturnBad"),
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [constI32(1), { kind: "early.return", value: asValueId(1), result: null, resultType: null }],
          terminator: { kind: "return", values: [asValueId(2)] },
        },
        // (unreachable second block keeps the terminator's own value defined)
      ],
      exported: false,
      valueCount: 64,
    };
    const hits = verify(fn).filter((m) => m.startsWith("early.return value type"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe("early.return value type i32 not assignable to declared result f64");
  });

  it("accepts a well-typed early.return", () => {
    const fn: IrFunction = {
      ...irIdentities.next("earlyReturnOk"),
      params: [],
      resultTypes: [],
      blocks: [block(0, [{ kind: "early.return", value: null, result: null, resultType: null }])],
      exported: false,
      valueCount: 64,
    };
    expect(verify(fn)).toEqual([]);
  });
});
