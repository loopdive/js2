// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 D1, Str2, Str2-c, O2, O2b, M2) The instruction builders of the dynamic-value legalization
 * (`dynamic-value-legalization.ts`): the kinds a value is proven to hold, the per-kind chains over the carrier, the
 * conversions (ToString, ToNumber) and the dynamic `+`. The pass decides which operation to rewrite; these build its
 * replacement.
 */
import type { irValueTypes } from "../analysis/value-types.js";
import type { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import { INTRINSIC_SIGNATURE_VERSION, INTRINSIC_DEFINITIONS, type IntrinsicId } from "../core/intrinsics.js";
import { forEachInstrDeep, type IrFunction, type IrInstr, type IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { PREPARED_NUMBER_TO_STRING } from "./number-to-string-target.js";
import { ordinaryToPrimitive } from "./ordinary-to-primitive.js";
import { realmCall } from "./dynamic-realm-calls.js";
import {
  ADD_ROLE,
  KIND_TEST,
  TO_NUMBER_ARM,
  TO_STRING_ARM,
  carrierKindOf,
  type CarrierKind,
  type LegalizationProgram,
} from "./dynamic-value-kinds.js";

/** The dynamic value's carrier, the native externref. */
export const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });

const STRING: IrType = Object.freeze({ kind: "string" });
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const TEST_RESULT: IrType = INTRINSIC_DEFINITIONS["js.value.is_string"].signature.result;
const I32: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32" }) });
/** (#7354 M2) `js.object.error-field`'s selectors. */
export const ERROR_FIELD = { message: 0, name: 1 } as const;

/**
 * (#7354 Str2-c) The kind each value of `fn` is proven to hold: a box to the dynamic value proves its operand's, and
 * the legalization records a concatenation's result as a string (`learn`). Any other value may hold every admitted
 * kind.
 */
export function knownKinds(
  fn: IrFunction,
  types: ReturnType<typeof irValueTypes>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  admitted: readonly CarrierKind[],
) {
  const known = new Map<IrValueId, CarrierKind>();
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        if (i.kind !== "box" || i.toType.kind !== "dynamic") return;
        const kind = carrierKindOf(i.value, types, definitions, i.toType.tag);
        if (kind && kind !== "dynamic") known.set(i.result!, kind);
      });
  return {
    kindsOf: (value: IrValueId): readonly CarrierKind[] => {
      const kind = known.get(value);
      return kind ? [kind] : admitted;
    },
    learn: (value: IrValueId, kind: CarrierKind) => known.set(value, kind),
  };
}
export type KnownKinds = ReturnType<typeof knownKinds>;

/**
 * The instruction builders of one function's legalization: fresh values after the function's own, intrinsic calls,
 * kind tests, and the per-kind chains (`kindChain`) that ToString, `typeof`, `+` and (#7354 O4, O3) member access
 * share.
 */
export function chainBuilders(
  fn: IrFunction,
  allocations: AllocSiteRegistry,
  kinds: KnownKinds,
  admitted: readonly CarrierKind[],
) {
  let valueCount = fn.valueCount;
  const intrinsic = (instr: IrInstr, id: IntrinsicId, args: readonly IrValueId[], result = instr.result): IrInstr => ({
    kind: "intrinsic",
    id,
    version: INTRINSIC_SIGNATURE_VERSION,
    args,
    result,
    resultType: INTRINSIC_DEFINITIONS[id].signature.result,
    ...(instr.site === undefined ? {} : { site: instr.site }),
  });
  const fresh = (): IrValueId => valueCount++ as IrValueId;
  /**
   * The tests or-ed left to right, each answering into its own value; the disjunction answers into `result`, or into
   * a fresh value when none is given (`cond`).
   */
  const disjunction = (
    tests: readonly ((result: IrValueId) => IrInstr[])[],
    result?: IrValueId,
  ): { readonly instrs: IrInstr[]; readonly cond: IrValueId } => {
    if (tests.length === 1) {
      const cond = result ?? fresh();
      return { instrs: tests[0]!(cond), cond };
    }
    const answers = tests.map((test) => {
      const cond = fresh();
      return { cond, instrs: test(cond) };
    });
    const instrs = answers.flatMap((answer) => answer.instrs);
    let cond = answers[0]!.cond;
    answers.slice(1).forEach((answer, index) => {
      const either = index === answers.length - 2 && result !== undefined ? result : fresh();
      instrs.push({
        kind: "binary",
        op: "i32.or",
        lhs: cond,
        rhs: answer.cond,
        result: either,
        resultType: TEST_RESULT,
      });
      cond = either;
    });
    return { instrs, cond };
  };
  /** (#7354 O2) Whether `value` is one of `kinds`: their tests, or-ed into `result`. */
  const anyKind = (instr: IrInstr, of: readonly CarrierKind[], value: IrValueId, result: IrValueId): IrInstr[] =>
    disjunction(
      of.map((kind) => (r: IrValueId) => kindTest(instr, kind, value, r, TEST_RESULT)),
      result,
    ).instrs;
  /**
   * The kind's test into `result`; (#7354 O2) an object is none of the other admitted kinds; (M2) an error is the
   * realm's test of its layout.
   */
  const kindTest = (
    instr: IrInstr,
    kind: CarrierKind,
    value: IrValueId,
    result: IrValueId,
    resultType = instr.resultType,
  ): IrInstr[] => {
    const test = KIND_TEST[kind];
    if (test === "complement") {
      const other = fresh();
      const others = admitted.filter((candidate) => KIND_TEST[candidate] !== "complement");
      return [
        ...anyKind(instr, others, value, other),
        { kind: "unary", op: "i32.eqz", rand: other, result, resultType },
      ];
    }
    if (test === "js.object.is-error") return [realmCall(test, [value], result)];
    return [
      test === "ref.is_null"
        ? { kind: "unary", op: "ref.is_null", rand: value, result, resultType }
        : intrinsic(instr, test, [value], result),
    ];
  };
  const text = (value: string, result: IrValueId): IrInstr => ({
    kind: "string.const",
    value,
    result,
    resultType: STRING,
    alloc: allocations.fresh("string", STRING),
  });
  const branch = (
    cond: IrValueId,
    then: (r: IrValueId) => IrInstr[],
    else_: (r: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType: IrType = STRING,
  ): IrInstr => {
    const thenValue = fresh();
    const elseValue = fresh();
    return {
      kind: "if",
      cond,
      then: then(thenValue),
      thenValue,
      else: else_(elseValue),
      elseValue,
      result,
      resultType,
    };
  };
  /** The concatenation of two native strings into `result`. */
  const concat = (lhs: IrValueId, rhs: IrValueId, result: IrValueId): IrInstr => ({
    kind: "string.concat",
    lhs,
    rhs,
    result,
    resultType: STRING,
    alloc: allocations.fresh("string", STRING),
    concatMode: "immutable",
  });
  /** (#7354 M2) The once-evaluated error `value`'s `field`, a native string carrier, into `result`. */
  const errorField = (value: IrValueId, field: keyof typeof ERROR_FIELD, result: IrValueId): IrInstr[] => {
    const selector = fresh();
    return [
      { kind: "const", value: { kind: "i32", value: ERROR_FIELD[field] }, result: selector, resultType: I32 },
      realmCall("js.object.error-field", [value, selector], result),
    ];
  };
  // A value per admitted kind of the once-evaluated `value`: a chain of tag tests in `KIND_ORDER`, the last kind
  // untested (the chain is total over the kinds), each arm answering into its own value.
  const kindChain = (
    instr: IrInstr,
    value: IrValueId,
    result: IrValueId,
    arm: (kind: CarrierKind, result: IrValueId) => IrInstr[],
    of: readonly CarrierKind[] = admitted,
    resultType: IrType = STRING,
  ): IrInstr[] => {
    const [kind, ...rest] = of;
    if (rest.length === 0) return arm(kind!, result);
    const cond = fresh();
    return [
      ...kindTest(instr, kind!, value, cond, TEST_RESULT),
      branch(
        cond,
        (r) => arm(kind!, r),
        (r) => kindChain(instr, value, r, arm, rest, resultType),
        result,
        resultType,
      ),
    ];
  };
  return {
    kinds,
    allocations,
    intrinsic,
    fresh,
    disjunction,
    anyKind,
    kindTest,
    text,
    branch,
    concat,
    errorField,
    kindChain,
    valueCount: () => valueCount,
  };
}
type ChainBuilders = ReturnType<typeof chainBuilders>;

/**
 * (#7354 Str2, O2b) The conversions of the dynamic value: ToString (`stringOf`, one arm per kind the value may hold,
 * `TO_STRING_ARM`) and ToNumber (`TO_NUMBER_ARM`). An object's arm of either is its OrdinaryToPrimitive
 * (`ordinary-to-primitive.ts`).
 */
export function conversionBuilders(builders: ChainBuilders, program: LegalizationProgram) {
  const { kinds, intrinsic, fresh, anyKind, text, branch, concat, errorField, kindChain } = builders;
  const toPrimitive = (value: IrValueId, result: IrValueId): IrInstr[] =>
    ordinaryToPrimitive({ carrier: CARRIER, fresh, text, branch }, program, value, result);
  const toStringArm = (instr: IrInstr, kind: CarrierKind, value: IrValueId, result: IrValueId): IrInstr[] => {
    switch (TO_STRING_ARM[kind]) {
      case "as-string":
        return [intrinsic(instr, "js.value.as_string", [value], result)];
      case "format": {
        const number = fresh();
        return [
          intrinsic(instr, "js.number.unbox", [value], number),
          { kind: "call", target: PREPARED_NUMBER_TO_STRING, args: [number], result, resultType: STRING },
        ];
      }
      case "boolean": {
        const flag = fresh();
        return [
          // ToBoolean of a Boolean is its payload; it needs no unbox policy.
          intrinsic(instr, "js.value.to_boolean", [value], flag),
          branch(
            flag,
            (r) => [text("true", r)],
            (r) => [text("false", r)],
            result,
          ),
        ];
      }
      case "name":
        return [text(kind, result)];
      // (#7354 M2) Error.prototype.toString (§20.5.3.4) of the realm's TypeError: its name is "TypeError" and its
      // message a non-empty text the legalization wrote, and no code can write either (a member write of an error
      // refuses), so the answer is always `name + ": " + message`.
      case "error": {
        const [name, nameText, separator, head, message, messageText] = Array.from({ length: 6 }, fresh);
        return [
          ...errorField(value, "name", name),
          intrinsic(instr, "js.value.as_string", [name], nameText),
          text(": ", separator),
          concat(nameText, separator, head),
          ...errorField(value, "message", message),
          intrinsic(instr, "js.value.as_string", [message], messageText),
          concat(head, messageText, result),
        ];
      }
      case "to-primitive":
        return toPrimitive(value, result);
    }
  };
  // ToString of the once-evaluated `value`: only the arms of the kinds it may hold.
  const stringOf = (instr: IrInstr, value: IrValueId, result: IrValueId): IrInstr[] =>
    kindChain(instr, value, result, (kind, r) => toStringArm(instr, kind, value, r), kinds.kindsOf(value));
  // ToNumber of the once-evaluated `value`: the primitive unboxer, or NaN for an object (ToNumber of
  // "[object Object]"; the string itself is not read, but its ToPrimitive may throw) and (M2) for an error.
  const toNumber = (instr: IrInstr, value: IrValueId, result: IrValueId): IrInstr[] => {
    const held = kinds.kindsOf(value);
    const unbox = (r: IrValueId): IrInstr[] => [intrinsic(instr, "js.number.unbox", [value], r)];
    const converted = held.filter((kind) => TO_NUMBER_ARM[kind] !== "unbox");
    if (converted.length === 0) return unbox(result);
    const nan = (kind: CarrierKind, r: IrValueId): IrInstr[] => [
      ...(TO_NUMBER_ARM[kind] === "to-primitive" ? toPrimitive(value, fresh()) : []),
      { kind: "const", value: { kind: "f64", value: NaN }, result: r, resultType: F64 },
    ];
    const toNan = (r: IrValueId) => kindChain(instr, value, r, nan, converted, F64);
    if (converted.length === held.length) return toNan(result);
    const cond = fresh();
    return [...anyKind(instr, converted, value, cond), branch(cond, toNan, unbox, result, F64)];
  };
  return { stringOf, toNumber };
}

/**
 * (#7354 Str2-c) The dynamic `+` of two once-evaluated operands (`ADD_ROLE`): a string (or, O2b, an object's
 * ToPrimitive) on either side concatenates their ToStrings, otherwise the ToNumbers are summed; either answer is
 * boxed back into the carrier. An operand of a known kind takes only its own arms: a known string makes the whole
 * addition a concatenation without a test, and only a side that may hold a string is tested.
 */
export function additionBuilder(builders: ChainBuilders, stringOf: ReturnType<typeof conversionBuilders>["stringOf"]) {
  const { kinds, intrinsic, fresh, kindTest, branch, disjunction } = builders;
  const concat = (instr: IrInstr, operands: readonly IrValueId[], r: IrValueId): IrInstr[] => {
    const [left, right, text] = [fresh(), fresh(), fresh()];
    return [
      ...stringOf(instr, operands[0]!, left),
      ...stringOf(instr, operands[1]!, right),
      builders.concat(left, right, text),
      { kind: "coerce.to_externref", value: text, result: r, resultType: CARRIER },
    ];
  };
  const sum = (instr: IrInstr, operands: readonly IrValueId[], r: IrValueId): IrInstr[] => {
    const [left, right, total] = [fresh(), fresh(), fresh()];
    return [
      intrinsic(instr, "js.number.unbox", [operands[0]!], left),
      intrinsic(instr, "js.number.unbox", [operands[1]!], right),
      { kind: "binary", op: "f64.add", lhs: left, rhs: right, result: total, resultType: F64 },
      intrinsic(instr, "js.number.box", [total], r),
    ];
  };
  return (instr: IrInstr, operands: readonly IrValueId[], result: IrValueId): IrInstr[] => {
    const roles = operands.map((value) => kinds.kindsOf(value).map((kind) => ADD_ROLE[kind]));
    if (roles.some((role) => role.every((r) => r === "concat"))) {
      // A concatenation is a known string to the next `+` of a chain (`"a" + v + "b"`). Legalization meets a value's
      // definition before its uses, so the next site reads this.
      kinds.learn(result, "string");
      return concat(instr, operands, result);
    }
    // The front end makes a `+` dynamic only over an operand of unknown kind (`emitDynamicAdd` in from-ast), which
    // may hold a string, so at least one operand is tested here.
    const { instrs, cond } = disjunction(
      operands.flatMap((value) =>
        kinds
          .kindsOf(value)
          .filter((kind) => ADD_ROLE[kind] === "concat")
          .map((kind) => (r: IrValueId) => kindTest(instr, kind, value, r, TEST_RESULT)),
      ),
    );
    return [
      ...instrs,
      branch(
        cond,
        (r) => concat(instr, operands, r),
        (r) => sum(instr, operands, r),
        result,
        CARRIER,
      ),
    ];
  };
}
