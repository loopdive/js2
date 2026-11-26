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
import { ordinaryToPrimitive, type ToPrimitiveAnswer, type ToPrimitiveHint } from "./ordinary-to-primitive.js";
import { realmCall } from "./dynamic-realm-calls.js";
import { functionValueOperand } from "./function-value-projection.js";
import type { OrdinaryObjectRuntimeFeature } from "../runtime/contracts/manifest.js";
import { ERROR_TO_STRING_ID, realmIntrinsicSelector } from "./builtin-prototype-keys.js";
import {
  ADD_ROLE,
  IS_OBJECT,
  KIND_TEST,
  TO_NUMBER_ARM,
  TO_STRING_ARM,
  carrierKindOf,
  holdsErrors,
  type CarrierKind,
  type LegalizationProgram,
} from "./dynamic-value-kinds.js";

/** The dynamic value's carrier, the native externref. */
export const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });

/** The carrier value `value` (a native string or a carrier value) into `result`, unchanged. */
export const carried = (value: IrValueId, result: IrValueId): IrInstr => ({
  kind: "coerce.to_externref",
  value,
  result,
  resultType: CARRIER,
});

const STRING: IrType = Object.freeze({ kind: "string" });
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const TEST_RESULT: IrType = INTRINSIC_DEFINITIONS["js.value.is_string"].signature.result;
const I32: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32" }) });

/**
 * (#7354 Str2-c) The kind each value of `fn` is proven to hold: a box to the dynamic value proves its operand's, (F1)
 * the function-value projection its packed callable's, (F1b) a read of a declaration's home a function, and
 * the legalization records a concatenation's result as a string and (F2) a ToPrimitive's result as a primitive
 * (`learn`). Any other value may hold every admitted kind.
 */
export function knownKinds(
  fn: IrFunction,
  types: ReturnType<typeof irValueTypes>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  admitted: readonly CarrierKind[],
) {
  const known = new Map<IrValueId, readonly CarrierKind[]>();
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        const projected = functionValueOperand(i);
        const kind =
          i.kind === "box" && i.toType.kind === "dynamic"
            ? carrierKindOf(i.value, types, definitions, i.toType.tag)
            : projected !== undefined
              ? carrierKindOf(projected, types, definitions)
              : i.kind === "global.get"
                ? carrierKindOf(i.result!, types, definitions)
                : undefined;
        if (kind && kind !== "dynamic") known.set(i.result!, [kind]);
      });
  return {
    kindsOf: (value: IrValueId): readonly CarrierKind[] => known.get(value) ?? admitted,
    learn: (value: IrValueId, kinds: readonly CarrierKind[]) => known.set(value, kinds),
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
  /** The kind's test into `result`; (#7354 O2) an object is none of the other admitted kinds. */
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
  /**
   * (#7354 C2) The run-time abort `js.value.unsupported` as a carrier answer into `result`: its text is the answer, as
   * an intrinsic is pure and an abort whose result nothing used would be dropped as dead code.
   */
  const abort = (instr: IrInstr, result: IrValueId): IrInstr[] => {
    const text = fresh();
    return [intrinsic(instr, "js.value.unsupported", [], text), carried(text, result)];
  };
  /** The realm's `feature` on `args` and, last, the constant `selector`, into `result`. */
  const selectorCall = (
    feature: OrdinaryObjectRuntimeFeature,
    args: readonly IrValueId[],
    selector: number,
    result: IrValueId,
  ): IrInstr[] => {
    const value = fresh();
    return [
      { kind: "const", value: { kind: "i32", value: selector }, result: value, resultType: I32 },
      realmCall(feature, [...args, value], result),
    ];
  };
  /** (#7354 P1, G1) The realm's built-in function object `id` (`NATIVE_VALUE_INTRINSICS`) into `result`. */
  const realmIntrinsic = (id: string, result: IrValueId): IrInstr[] =>
    selectorCall("js.object.intrinsic", [], realmIntrinsicSelector(id), result);
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
    admitted,
    allocations,
    intrinsic,
    fresh,
    disjunction,
    anyKind,
    kindTest,
    text,
    branch,
    concat,
    abort,
    selectorCall,
    realmIntrinsic,
    kindChain,
    valueCount: () => valueCount,
  };
}
export type ChainBuilders = ReturnType<typeof chainBuilders>;

/** Which of OrdinaryToPrimitive's two receivers a `to-primitive` kind is. */
const receiverKind = (kind: CarrierKind): "object" | "function" => (kind === "function" ? "function" : "object");

/**
 * (#7354 Str2, O2b, F2) The conversions of the dynamic value: ToString (`stringOf`, one arm per kind the value may
 * hold, `TO_STRING_ARM`), ToNumber (`TO_NUMBER_ARM`) and `+`'s ToPrimitive (`primitiveOf`). The arm of an object and
 * of a function value is its OrdinaryToPrimitive (`ordinary-to-primitive.ts`), whose primitive each conversion
 * finishes in its own way (`ToPrimitiveAnswer`).
 */
export function conversionBuilders(builders: ChainBuilders, program: LegalizationProgram) {
  const { kinds, admitted, intrinsic, fresh, anyKind, text, branch, kindChain } = builders;
  const unsupported = (instr: IrInstr, r: IrValueId) => intrinsic(instr, "js.value.unsupported", [], r);
  const nan = (r: IrValueId): IrInstr => ({
    kind: "const",
    value: { kind: "f64", value: NaN },
    result: r,
    resultType: F64,
  });
  /** (#7354 G1) The realm's Error.prototype.toString, recognised by identity (`ordinary-to-primitive.ts`). */
  const errorToString = (instr: IrInstr) => ({
    is: (method: IrValueId, r: IrValueId): IrInstr[] => {
      const builtin = fresh();
      return [
        ...builders.realmIntrinsic(ERROR_TO_STRING_ID, builtin),
        intrinsic(instr, "js.value.strict_eq", [method, builtin], r),
      ];
    },
    answer: (object: IrValueId, r: IrValueId): IrInstr[] => [realmCall("js.object.error-to-string", [object], r)],
  });
  /** The kinds a conversion method's result answers with (§7.1.1.1 step 2.b.ii): every admitted one but objects. */
  const primitives = admitted.filter((kind) => !IS_OBJECT[kind]);
  const toPrimitive = (
    instr: IrInstr,
    value: IrValueId,
    hint: ToPrimitiveHint,
    result: IrValueId,
    kind: CarrierKind,
    answer: ToPrimitiveAnswer,
  ): IrInstr[] => {
    const b = {
      carrier: CARRIER,
      fresh,
      text,
      branch,
      isCallable: admitted.includes("function")
        ? (method: IrValueId, r: IrValueId) => intrinsic(instr, "js.value.is_function", [method], r)
        : undefined,
      isPrimitive: (v: IrValueId, r: IrValueId) => anyKind(instr, primitives, v, r),
      ...(holdsErrors(program) ? { errorToString: errorToString(instr) } : {}),
      ...(program.objects.functions ? {} : { builtinOnly: (r: IrValueId) => builders.abort(instr, r) }),
    };
    return ordinaryToPrimitive(b, program, value, hint, result, receiverKind(kind), answer);
  };
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
      // (F1b) A function's absent `toString` is the source text, which the closure does not carry: the run-time abort.
      case "to-primitive":
        return toPrimitive(instr, value, "string", result, kind, {
          type: STRING,
          text: (source, r) => [source === undefined ? unsupported(instr, r) : text(source, r)],
          primitive: (primitive, r) => stringOf(instr, primitive, r, primitives),
        });
    }
  };
  // ToString of the once-evaluated `value`: only the arms of the kinds it may hold (`held`).
  const stringOf = (
    instr: IrInstr,
    value: IrValueId,
    result: IrValueId,
    held: readonly CarrierKind[] = kinds.kindsOf(value),
  ): IrInstr[] => kindChain(instr, value, result, (kind, r) => toStringArm(instr, kind, value, r), held);
  // ToNumber of the once-evaluated `value`: the primitive unboxer, or an object's or a function's ToPrimitive (any text
  // a built-in method answers is read as a number).
  const toNumber = (instr: IrInstr, value: IrValueId, result: IrValueId): IrInstr[] => {
    const held = kinds.kindsOf(value);
    const unbox = (v: IrValueId, r: IrValueId): IrInstr[] => [intrinsic(instr, "js.number.unbox", [v], r)];
    const converted = held.filter((kind) => TO_NUMBER_ARM[kind] !== "unbox");
    if (converted.length === 0) return unbox(value, result);
    const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] =>
      toPrimitive(instr, value, "number", r, kind, { type: F64, text: (_, s) => [nan(s)], primitive: unbox });
    const convert = (r: IrValueId) => kindChain(instr, value, r, arm, converted, F64);
    if (converted.length === held.length) return convert(result);
    const cond = fresh();
    return [...anyKind(instr, converted, value, cond), branch(cond, convert, (r) => unbox(value, r), result, F64)];
  };
  /**
   * (#7354 F2) `+`'s ToPrimitive (hint default, read as number) of the once-evaluated `value`: a carrier of a primitive
   * kind, which `learn` records for the addition's roles. A value that may hold no object is its own primitive.
   */
  const primitiveOf = (instr: IrInstr, value: IrValueId): { readonly instrs: IrInstr[]; readonly value: IrValueId } => {
    const held = kinds.kindsOf(value);
    if (!held.some((kind) => ADD_ROLE[kind] === "to-primitive")) return { instrs: [], value };
    const result = fresh();
    const answer: ToPrimitiveAnswer = {
      type: CARRIER,
      text: (source, r) => {
        const string = fresh();
        return [source === undefined ? unsupported(instr, string) : text(source, string), carried(string, r)];
      },
      primitive: (primitive, r) => [carried(primitive, r)],
    };
    const instrs = kindChain(
      instr,
      value,
      result,
      (kind, r) =>
        ADD_ROLE[kind] === "to-primitive" ? toPrimitive(instr, value, "number", r, kind, answer) : [carried(value, r)],
      held,
      CARRIER,
    );
    // Without a callable kind no conversion method runs, so an object's primitive is a built-in method's text.
    const answers: readonly CarrierKind[] = admitted.includes("function") ? primitives : ["string"];
    kinds.learn(
      result,
      admitted.filter((kind) => answers.includes(kind) || (held.includes(kind) && ADD_ROLE[kind] !== "to-primitive")),
    );
    return { instrs, value: result };
  };
  return { stringOf, toNumber, primitiveOf };
}

/**
 * (#7354 Str2-c, F2) The dynamic `+` of two once-evaluated operands (`ADD_ROLE`): each operand's ToPrimitive first
 * (`primitiveOf`, left then right), then a string on either side concatenates their ToStrings, otherwise the ToNumbers
 * are summed; either answer is boxed back into the carrier. An operand of a known kind takes only its own arms: a
 * known string makes the whole addition a concatenation without a test, and only a side that may hold a string is
 * tested.
 */
export function additionBuilder(builders: ChainBuilders, conversions: ReturnType<typeof conversionBuilders>) {
  const { kinds, intrinsic, fresh, kindTest, branch, disjunction } = builders;
  const { stringOf, primitiveOf } = conversions;
  const concat = (instr: IrInstr, operands: readonly IrValueId[], r: IrValueId): IrInstr[] => {
    const [left, right, text] = [fresh(), fresh(), fresh()];
    return [
      ...stringOf(instr, operands[0]!, left),
      ...stringOf(instr, operands[1]!, right),
      builders.concat(left, right, text),
      carried(text, r),
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
  return (instr: IrInstr, values: readonly IrValueId[], result: IrValueId): IrInstr[] => {
    const converted = values.map((value) => primitiveOf(instr, value));
    const prelude = converted.flatMap((operand) => operand.instrs);
    const operands = converted.map((operand) => operand.value);
    const roles = operands.map((value) => kinds.kindsOf(value).map((kind) => ADD_ROLE[kind]));
    if (roles.some((role) => role.every((r) => r === "concat"))) {
      // A concatenation is a known string to the next `+` of a chain (`"a" + v + "b"`). Legalization meets a value's
      // definition before its uses, so the next site reads this.
      kinds.learn(result, ["string"]);
      return [...prelude, ...concat(instr, operands, result)];
    }
    // The front end makes a `+` dynamic only over an operand of unknown kind (`emitDynamicAdd` in from-ast), which
    // may hold a string (an object's primitive may too), so at least one operand is tested here.
    const { instrs, cond } = disjunction(
      operands.flatMap((value) =>
        kinds
          .kindsOf(value)
          .filter((kind) => ADD_ROLE[kind] === "concat")
          .map((kind) => (r: IrValueId) => kindTest(instr, kind, value, r, TEST_RESULT)),
      ),
    );
    return [
      ...prelude,
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
