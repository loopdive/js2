// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 D1) Dynamic-value legalization for the Prepared standalone WasmGC
 * source program.
 *
 * The Prepared backend binds runtime functions only through semantic
 * intrinsics, so the dynamic IR operations from-ast emits (`box` to dynamic,
 * `unbox`, `tag.test`, `dyn.*`) are rewritten into the intrinsics that name
 * the same meaning, and every `dynamic` type becomes its carrier, an
 * `externref`. The source producer runs it on each lowered function, so every
 * later stage (runtime projection, validator replay, physical plan) sees one
 * ordinary externref program. The pass is total: an operation it cannot
 * express throws {@link DynamicValueGap} with a name instead of reaching the
 * backend.
 *
 * Soundness rests on the admitted value set: only numbers, booleans,
 * native strings (#7354 Str), `undefined` and `null` can enter a dynamic
 * value here (every other box refuses), and the runtime functions behind the intrinsics are exact for that
 * set. (#7354 T) `null` is the carrier's null reference, as on the ordinary
 * standalone pipeline; `undefined` is the non-null singleton, so the two stay
 * apart under strict equality and the `undefined` probe.
 */
import { irValueTypes } from "../analysis/value-types.js";
import type { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import { INTRINSIC_SIGNATURE_VERSION, INTRINSIC_DEFINITIONS, type IntrinsicId } from "../core/intrinsics.js";
import {
  forEachInstrDeep,
  mapNestedBuffers,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrValueId,
} from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { irRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";
import { typeofComparisons } from "./typeof-comparisons.js";
import { PREPARED_NUMBER_TO_STRING } from "./number-to-string-target.js";
import { IR_DYN_ADD_FN } from "../../shared/contracts/dynamic-add-helper.js";
import { gap } from "./dynamic-value-gap.js";
import { dynamicMemberRead } from "./dynamic-member-read.js";
import {
  ADD_ROLE,
  KIND_TEST,
  NO_OBJECTS,
  KINDS_OF_TYPEOF,
  TO_NUMBER_ARM,
  TO_STRING_ARM,
  TYPEOF_NAME,
  admittedKinds,
  boxedKind,
  plainObjectRefusal,
  type CarrierKind,
  type ProgramObjects,
} from "./dynamic-value-kinds.js";

const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });

export { DynamicValueGap } from "./dynamic-value-gap.js";

/** Walk the data structurally: IR constants may hold bigints, which JSON cannot. */
function containsDynamic(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { kind?: unknown }).kind === "dynamic") return true;
  return Object.values(value).some(containsDynamic);
}

function carrierOf(type: IrType): IrType {
  return type.kind === "dynamic" ? CARRIER : type;
}

/** Each value's defining instruction, nested buffers included. */
function valueDefinitions(fn: IrFunction): Map<IrValueId, IrInstr> {
  const definitions = new Map<IrValueId, IrInstr>();
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        if (i.result !== null && i.result !== undefined) definitions.set(i.result, i);
      });
  return definitions;
}

/**
 * (#7354 X, O1, O2) The kind the carrier holds `value` as, from its type and defining instruction: the dynamic value
 * itself, a native string (its own payload), a boundary box's number or Boolean, the null constant's null reference,
 * an ordinary object `boxedKind` admits, or, through a coercion, its operand's kind. Any other value has none: a
 * callable until slice Fa gives it its tag.
 */
export function carrierKind(
  value: IrValueId,
  types: ReadonlyMap<IrValueId, IrType>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): "dynamic" | "string" | "number" | "boolean" | "null" | "object" | undefined {
  const type = types.get(value);
  if (type?.kind === "dynamic" || type?.kind === "string") return type.kind;
  const definition = definitions.get(value);
  if (definition?.kind === "intrinsic" && definition.id === "js.number.box") return "number";
  if (definition?.kind === "intrinsic" && definition.id === "js.boolean.box") return "boolean";
  if (definition?.kind === "const" && definition.value.kind === "null") return "null";
  if (boxedKind(JS_TAG_IDS.Object, undefined, definition) === "object") return "object";
  return definition?.kind === "coerce.to_externref" ? carrierKind(definition.value, types, definitions) : undefined;
}

/** A value {@link carrierKind} has no kind for (through its coercions), as a refusal names it. */
function unadmittedValue(
  value: IrValueId,
  types: ReadonlyMap<IrValueId, IrType>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): string {
  const definition = definitions.get(value);
  if (definition?.kind === "coerce.to_externref") return unadmittedValue(definition.value, types, definitions);
  const type = types.get(value);
  return `a value of type ${type?.kind === "val" ? type.val.kind : type?.kind}`;
}

const STRING: IrType = Object.freeze({ kind: "string" });
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const TEST_RESULT: IrType = INTRINSIC_DEFINITIONS["js.value.is_string"].signature.result;

/**
 * The instruction builders of one function's legalization: fresh values after the function's own, intrinsic
 * calls, kind tests and the per-kind chains (`kindChain`) that ToString, `typeof` and (#7354 Str2-c) `+` share.
 */
function legalizationBuilders(
  fn: IrFunction,
  allocations: AllocSiteRegistry,
  types: ReturnType<typeof irValueTypes>,
  { objects, catches }: LegalizationProgram,
) {
  let valueCount = fn.valueCount;
  const admitted = admittedKinds(objects);
  const intrinsic = (instr: IrInstr, id: IntrinsicId, args: readonly IrValueId[], result = instr.result): IrInstr => ({
    kind: "intrinsic",
    id,
    version: INTRINSIC_SIGNATURE_VERSION,
    args,
    result,
    resultType: INTRINSIC_DEFINITIONS[id].signature.result,
    ...(instr.site === undefined ? {} : { site: instr.site }),
  });
  // (#7354 Str2-c) The kind a box to the dynamic value (or a concatenation, below) proves for its result: a `+`
  // operand of a known kind takes only that kind's arm.
  const definitions = valueDefinitions(fn);
  /** The kind a box to the dynamic value admits (`boxedKind`); `undefined` for any other box. */
  const kindOfBox = (box: Extract<IrInstr, { kind: "box" }>): CarrierKind | undefined =>
    box.toType.kind === "dynamic"
      ? boxedKind(box.toType.tag, types.get(box.value), definitions.get(box.value))
      : undefined;
  const boxed = new Map<IrValueId, CarrierKind>();
  for (const i of definitions.values()) {
    const kind = i.kind === "box" && kindOfBox(i);
    if (kind) boxed.set(i.result!, kind);
  }
  const kindsOf = (value: IrValueId): readonly CarrierKind[] => {
    const kind = boxed.get(value);
    return kind ? [kind] : admitted;
  };
  const fresh = (): IrValueId => valueCount++ as IrValueId;
  /** (#7354 O2) Whether `value` is one of `kinds`: their tests, or-ed into `result`. */
  const anyKind = (instr: IrInstr, kinds: readonly CarrierKind[], value: IrValueId, result: IrValueId): IrInstr[] =>
    disjunction(
      kinds.map((kind) => (r: IrValueId) => kindTest(instr, kind, value, r, TEST_RESULT)),
      result,
    );
  /** The tests or-ed into `result`, each answering into its own value. */
  const disjunction = (tests: readonly ((result: IrValueId) => IrInstr[])[], result: IrValueId): IrInstr[] => {
    const [first, ...rest] = tests;
    if (rest.length === 0) return first!(result);
    const [left, right] = [fresh(), fresh()];
    return [
      ...first!(left),
      ...disjunction(rest, right),
      { kind: "binary", op: "i32.or", lhs: left, rhs: right, result, resultType: TEST_RESULT },
    ];
  };
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
      return [
        ...anyKind(
          instr,
          admitted.filter((candidate) => KIND_TEST[candidate] !== "complement"),
          value,
          other,
        ),
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
  // (#7354 Str2) ToString of the once-evaluated `value`, one arm per admitted kind (`TO_STRING_ARM`).
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
      case "plain-object":
        return [text(plainObjectToPrimitive(), result)];
    }
  };
  /** (#7354 O2) OrdinaryToPrimitive of a plain object (`TO_STRING_ARM`), or the named refusal. */
  const plainObjectToPrimitive = (): string => {
    const refusal = plainObjectRefusal(objects, "ToPrimitive of an object");
    return refusal === undefined ? "[object Object]" : gap(refusal);
  };
  /** (#7354 O2) ToNumber of the once-evaluated `value` (`TO_NUMBER_ARM`): a plain object's is NaN. */
  const toNumber = (instr: IrInstr, value: IrValueId, result: IrValueId): IrInstr[] => {
    const kinds = kindsOf(value);
    const unbox = (r: IrValueId): IrInstr[] => [intrinsic(instr, "js.number.unbox", [value], r)];
    if (kinds.every((kind) => TO_NUMBER_ARM[kind] === "unbox")) return unbox(result);
    plainObjectToPrimitive();
    const nan = (r: IrValueId): IrInstr[] => [
      { kind: "const", value: { kind: "f64", value: NaN }, result: r, resultType: F64 },
    ];
    if (kinds.every((kind) => TO_NUMBER_ARM[kind] === "plain-object")) return nan(result);
    const cond = fresh();
    return [...kindTest(instr, "object", value, cond, TEST_RESULT), branch(cond, nan, unbox, result, F64)];
  };
  // A string per admitted kind of the once-evaluated `value`: a chain of tag tests in `KIND_ORDER`, the last kind
  // untested (the chain is total over the kinds), each arm answering into its own value.
  const kindChain = (
    instr: IrInstr,
    value: IrValueId,
    result: IrValueId,
    arm: (kind: CarrierKind, result: IrValueId) => IrInstr[],
    kinds: readonly CarrierKind[] = admitted,
    resultType: IrType = STRING,
  ): IrInstr[] => {
    const [kind, ...rest] = kinds;
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
  const memberRead = (instr: IrInstr, receiver: IrValueId, key: IrValueId, result: IrValueId): IrInstr[] =>
    dynamicMemberRead(
      { carrier: CARRIER, definitions, fresh, text, intrinsic, kindsOf, kindChain },
      { objects, catches },
      instr,
      receiver,
      key,
      result,
    );
  const stringOf = (instr: IrInstr, value: IrValueId, result: IrValueId): IrInstr[] =>
    kindChain(instr, value, result, (kind, r) => toStringArm(instr, kind, value, r), kindsOf(value));
  /**
   * (#7354 Str2-c) The dynamic `+` of two once-evaluated operands (`ADD_ROLE`): a string on either side concatenates
   * their ToStrings, otherwise the ToNumbers are summed; either answer is boxed back into the carrier. An operand of
   * a known kind takes only its own arms: a known string makes the whole addition a concatenation without a test,
   * and only a side that may hold a string is tested.
   */
  const addition = (instr: IrInstr, operands: readonly IrValueId[], result: IrValueId): IrInstr[] => {
    const concat = (r: IrValueId): IrInstr[] => {
      const [left, right, text] = [fresh(), fresh(), fresh()];
      return [
        ...stringOf(instr, operands[0]!, left),
        ...stringOf(instr, operands[1]!, right),
        {
          kind: "string.concat",
          lhs: left,
          rhs: right,
          result: text,
          resultType: STRING,
          alloc: allocations.fresh("string", STRING),
          concatMode: "immutable",
        },
        { kind: "coerce.to_externref", value: text, result: r, resultType: CARRIER },
      ];
    };
    const sum = (r: IrValueId): IrInstr[] => {
      const [left, right, total] = [fresh(), fresh(), fresh()];
      return [
        intrinsic(instr, "js.number.unbox", [operands[0]!], left),
        intrinsic(instr, "js.number.unbox", [operands[1]!], right),
        { kind: "binary", op: "f64.add", lhs: left, rhs: right, result: total, resultType: F64 },
        intrinsic(instr, "js.number.box", [total], r),
      ];
    };
    const roles = operands.map((value) => kindsOf(value).map((kind) => ADD_ROLE[kind]));
    if (roles.some((role) => role.every((r) => r === "concat"))) {
      // A concatenation is a known string to the next `+` of a chain (`"a" + v + "b"`). Legalization meets a value's
      // definition before its uses, so the next site reads this.
      boxed.set(result, "string");
      return concat(result);
    }
    const tested = operands.flatMap((value) =>
      kindsOf(value)
        .filter((kind) => ADD_ROLE[kind] === "concat")
        .map((kind) => ({ kind, value })),
    );
    if (tested.length === 0) return sum(result);
    const cond = fresh();
    const conds = disjunction(
      tested.map(
        ({ kind, value }) =>
          (r: IrValueId) =>
            kindTest(instr, kind, value, r, TEST_RESULT),
      ),
      cond,
    );
    return [...conds, branch(cond, concat, sum, result, CARRIER)];
  };
  return {
    intrinsic,
    fresh,
    kindTest,
    anyKind,
    kindOfBox,
    text,
    kindChain,
    toStringArm,
    toNumber,
    memberRead,
    addition,
    definitions,
    admitted,
    valueCount: () => valueCount,
  };
}

/** (#7354 O2, O4) What the legalization of every function of one program asks of the whole program. */
export interface LegalizationProgram {
  /** Whether the program builds objects, and whether they are plain (`source-plain-objects.ts`). */
  readonly objects: ProgramObjects;
  /** Whether the program binds a catch: a value thrown here may then be read back as a dynamic value. */
  readonly catches: boolean;
}

/**
 * Rewrite one function. A function without a dynamic value is returned unchanged. `allocations` is the source's
 * registry: (#7354 Str2) ToString's literal arms are string allocation sites.
 */
export function legalizeDynamicValues(
  fn: IrFunction,
  allocations: AllocSiteRegistry,
  program: LegalizationProgram = { objects: NO_OBJECTS, catches: false },
): IrFunction {
  if (!containsDynamic(fn)) return fn;
  const types = irValueTypes(fn);
  const builders = legalizationBuilders(fn, allocations, types, program);
  const { intrinsic, fresh, kindTest, anyKind, kindOfBox, text, kindChain, toStringArm, toNumber, definitions } =
    builders;
  const isDynamic = (value: IrValueId): boolean => types.get(value)?.kind === "dynamic";
  const typeofs = typeofComparisons(fn);
  // `!==`/`!=`: the positive test into a fresh value, then its negation into the comparison's result.
  const withSense = (instr: IrInstr, negate: boolean, positive: (result: IrValueId) => IrInstr[]): IrInstr[] => {
    if (!negate) return positive(instr.result!);
    const value = fresh();
    return [
      ...positive(value),
      { kind: "unary", op: "i32.eqz", rand: value, result: instr.result, resultType: instr.resultType },
    ];
  };

  const expand = (instr: IrInstr): readonly IrInstr[] => {
    switch (instr.kind) {
      case "box": {
        if (instr.toType.kind !== "dynamic") return [instr];
        switch (kindOfBox(instr)) {
          case "boolean":
            return [intrinsic(instr, "js.boolean.box", [instr.value])];
          // The Null partition has one value, the carrier's null reference.
          case "null":
            return [{ kind: "const", value: { kind: "null", ty: CARRIER }, result: instr.result, resultType: CARRIER }];
          case "number":
            return [intrinsic(instr, "js.number.box", [instr.value])];
          // (#7354 Str) A native string is its own carrier payload: the externref that wraps it; (#7354 O2) an ordinary
          // object is one already.
          case "string":
          case "object":
            return [
              {
                kind: "coerce.to_externref",
                value: instr.value,
                result: instr.result,
                resultType: CARRIER,
                ...(instr.site === undefined ? {} : { site: instr.site }),
              },
            ];
          default:
            return gap(`box of a non-primitive value`);
        }
      }
      case "unbox":
        if (!isDynamic(instr.value)) return [instr];
        if (instr.tagId === JS_TAG_IDS.NumberF64) return [intrinsic(instr, "js.number.unbox", [instr.value])];
        return gap(`unbox of tag ${instr.tagId}`);
      // Only the `undefined` and `null` probes have a source producer here; the number and Boolean tests come
      // from a `typeof` comparison (the `string.eq` arm below).
      case "tag.test": {
        if (!isDynamic(instr.value)) return [instr];
        const kind =
          instr.tagId === JS_TAG_IDS.Undefined
            ? "undefined"
            : instr.tagId === JS_TAG_IDS.Null
              ? "null"
              : instr.tagId === JS_TAG_IDS.Object && builders.admitted.includes("object")
                ? "object"
                : undefined;
        // (#7368) No admitted kind is callable, so the Function test (§7.2.3) is false.
        if (instr.tagId === JS_TAG_IDS.Function)
          return [
            { kind: "const", value: { kind: "bool", value: false }, result: instr.result, resultType: TEST_RESULT },
          ];
        return kind === undefined
          ? gap(`tag.test of tag ${instr.tagId}`)
          : kindTest(instr, kind, instr.value, instr.result!);
      }
      // (#7354 Ty) `typeof v <op> "literal"` is a tag test on `v`; the `typeof` string and the literal are
      // consumed by it. A literal no admitted kind answers is constant: `v` was already evaluated.
      case "string.eq": {
        const comparison = typeofs.comparisons.get(instr.result!);
        if (comparison === undefined) return [instr];
        const kinds = KINDS_OF_TYPEOF.get(comparison.literal)?.filter((kind) => builders.admitted.includes(kind));
        if (kinds === undefined || kinds.length === 0)
          return [
            {
              kind: "const",
              value: { kind: "bool", value: comparison.negate },
              result: instr.result,
              resultType: instr.resultType,
            },
          ];
        return withSense(instr, comparison.negate, (result) => anyKind(instr, kinds, comparison.operand, result));
      }
      // (#7354 Str2) A `typeof` read other than by a literal comparison is its answer string.
      case "dyn.typeof":
        if (typeofs.consumed.has(instr.result!)) return [];
        return kindChain(instr, instr.value, instr.result!, (kind, result) => [text(TYPEOF_NAME[kind], result)]);
      case "string.const":
        return typeofs.consumed.has(instr.result!) ? [] : [instr];
      case "dyn.undefined":
        return [intrinsic(instr, "js.value.undefined", [])];
      case "dyn.to_string":
        return kindChain(instr, instr.value, instr.result!, (kind, result) =>
          toStringArm(instr, kind, instr.value, result),
        );
      case "dyn.truthy":
        return [intrinsic(instr, "js.value.to_boolean", [instr.value])];
      case "dyn.to_number":
        return toNumber(instr, instr.value, instr.result!);
      case "dyn.member_get":
        return builders.memberRead(instr, instr.recv, instr.key, instr.result!);
      case "dyn.eq": {
        if (instr.loose) return gap("dyn.eq (loose)");
        return withSense(instr, instr.negate, (result) => [
          intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs], result),
        ]);
      }
      // A front-end dynamic helper (`__ir_dyn_lt`, ...) has no runtime declaration; (#7354 Str2-c) `__ir_dyn_add`
      // is the dynamic `+`, expanded here.
      case "call":
        if (instr.target.binding.kind === "runtime" && instr.target.binding.symbol === IR_DYN_ADD_FN)
          return builders.addition(instr, instr.args, instr.result!);
        // (#7368) `throw new TypeError(message)` (`throw-type-error.ts`) builds the realm's TypeError.
        if (instr.target.binding.kind === "runtime" && instr.target.binding.symbol === "__new_TypeError")
          return [{ ...instr, target: irIntrinsicFuncRef("js.object.create-type-error"), resultType: CARRIER }];
        return instr.target.binding.kind === "runtime" &&
          !irRuntimeCallableDeclaration(instr.target) &&
          [instr.resultType, ...instr.args.map((arg) => types.get(arg))].some((type) => type?.kind === "dynamic")
          ? gap(instr.target.name)
          : [instr];
      // (#7354 X, O1) The carrier already is the native externref value: the exception payload a thrown dynamic
      // value carries and the value an ordinary object's property stores. A coercion to it keeps, and lowers to
      // nothing over the legalized operand, only for an operand of a kind the carrier holds. (A callable pack is
      // a coercion to the callable type, not to the carrier.)
      case "coerce.to_externref": {
        const target = instr.resultType;
        const toCarrier = target?.kind === "dynamic" || (target?.kind === "val" && target.val.kind === "externref");
        return !toCarrier || carrierKind(instr.value, types, definitions) !== undefined
          ? [instr]
          : gap(`coerce.to_externref of ${unadmittedValue(instr.value, types, definitions)}`);
      }
      default:
        return instr.kind.startsWith("dyn.") ? gap(instr.kind) : [instr];
    }
  };
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] =>
    buffer.flatMap((instr) => {
      const nested = mapNestedBuffers(instr, mapBuffer);
      return expand(nested).map((out) =>
        out.resultType?.kind === "dynamic" ? ({ ...out, resultType: CARRIER } as IrInstr) : out,
      );
    });
  const legalized: IrFunction = {
    ...fn,
    params: fn.params.map((param) => ({ ...param, type: carrierOf(param.type) })),
    resultTypes: fn.resultTypes.map(carrierOf),
    blocks: fn.blocks.map((block) => ({
      ...block,
      blockArgTypes: block.blockArgTypes.map(carrierOf),
      instrs: mapBuffer(block.instrs),
    })),
    valueCount: builders.valueCount(),
  };
  // Any `dynamic` left (inside a composite type, an async frame, a closure
  // signature) has no carrier on this projection.
  if (containsDynamic(legalized)) gap("on a value of composite type");
  return legalized;
}

/**
 * (#7368) The `js.object.*` operations that reject with the realm's TypeError: a define (§10.1.6.3) and
 * [[GetOwnProperty]] of a nullish receiver. On an object `js.object.create-default` has just built, none can.
 */
const REALM_REJECTING: ReadonlySet<string> = new Set([
  "js.object.define-data",
  "js.object.define-accessor",
  "js.object.define-attributes",
  "js.object.get-own-property",
]);

function isFreshObject(value: IrValueId, definitions: ReadonlyMap<IrValueId, IrInstr>): boolean {
  let definition = definitions.get(value);
  while (definition?.kind === "coerce.to_externref" || definition?.kind === "box")
    definition = definitions.get(definition.value);
  return definition?.kind === "call" && definition.target.name === "js.object.create-default";
}

/**
 * (#7354 X, O1) A catch binding reads the thrown payload back as the dynamic value, so in a program that binds one,
 * every throw, in whichever function, must be a value of a {@link carrierKind}. Any other value refuses by name.
 */
export function refuseUnadmittedThrows(fn: IrFunction): void {
  const definitions = valueDefinitions(fn);
  const throws: IrValueId[] = [];
  const rejecting: IrValueId[] = [];
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        if (i.kind === "throw") throws.push(i.value);
        if (i.kind === "call" && i.target.binding.kind === "intrinsic" && REALM_REJECTING.has(i.target.binding.symbol))
          rejecting.push(i.args[0]!);
      });
  // (#7368) The realm's own TypeError is no carrier kind either: an operation that may reject throws it.
  if (rejecting.some((object) => !isFreshObject(object, definitions)))
    gap("an object operation that may reject with a TypeError, in a program that catches");
  if (throws.length === 0) return;
  const types = irValueTypes(fn);
  for (const value of throws)
    if (carrierKind(value, types, definitions) === undefined)
      gap(`throw of a value outside the dynamic carrier's kinds (${unadmittedValue(value, types, definitions)})`);
}

/** A source global as the producer hands it over: its storage, and the unit that initialises it. */
interface SourceGlobal {
  readonly binding: { readonly globalRef: IrGlobalRef; readonly type: IrType };
  readonly identity: { readonly storageOwnerUnitId: IrUnitId };
}

/**
 * (#7354 H) The globals arm, over functions already legalized. A dynamic global (a script `var` without a
 * proven typed home) is stored as the carrier. JavaScript hoists such a `var` with the value `undefined`, so
 * its storage owner, the script's module-init, stores `undefined` before its first statement; nothing runs
 * before that, so the physical global's own default (a null externref, outside the admitted set) is never
 * read.
 */
export function legalizeDynamicGlobals<Global extends SourceGlobal>(
  functions: readonly IrFunction[],
  globals: readonly Global[],
): { readonly functions: readonly IrFunction[]; readonly globals: readonly Global[] } {
  const dynamic = globals.filter((global) => global.binding.type.kind === "dynamic");
  if (dynamic.length === 0) return { functions, globals };
  return {
    functions: functions.map((fn) => {
      const owned = dynamic.filter((global) => global.identity.storageOwnerUnitId === fn.unitId);
      return owned.length === 0 ? fn : storeUndefinedFirst(fn, owned);
    }),
    globals: globals.map((global) =>
      dynamic.includes(global) ? { ...global, binding: { ...global.binding, type: CARRIER } } : global,
    ),
  };
}

function storeUndefinedFirst(fn: IrFunction, globals: readonly SourceGlobal[]): IrFunction {
  const value = fn.valueCount as IrValueId;
  const prologue: IrInstr[] = [
    {
      kind: "intrinsic",
      id: "js.value.undefined",
      version: INTRINSIC_SIGNATURE_VERSION,
      args: [],
      result: value,
      resultType: INTRINSIC_DEFINITIONS["js.value.undefined"].signature.result,
    },
    ...globals.map(
      (global): IrInstr => ({
        kind: "global.set",
        target: global.binding.globalRef,
        value,
        result: null,
        resultType: null,
      }),
    ),
  ];
  const [entry, ...rest] = fn.blocks;
  return { ...fn, blocks: [{ ...entry!, instrs: [...prologue, ...entry!.instrs] }, ...rest], valueCount: value + 1 };
}
