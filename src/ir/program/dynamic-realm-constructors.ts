// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1, W2) The realm's constructors on the dynamic-value legalization: the Error family, `Object` and the
 * wrapper constructors `String`, `Number`, `Boolean`.
 *
 * Construction. `X(v)` and `new X(v)` with `X` an unchanged global realm constructor lower as F2's call and C2's
 * `dyn.construct` through the identifier's value, which is the realm's `js.object.intrinsic(<X>)`
 * (`identifier-read.ts` proves the global pristine). A call or construct whose callee is that value is the
 * constructor's own algorithm here, written at the site; the arguments are already evaluated (the front end, left to
 * right). Any other callee holding the constructor (through a variable) reaches the dispatcher, whose built-in arm is
 * the run-time abort.
 *
 * - An Error constructor (§20.5.1.1 / §20.5.6.1.1): OrdinaryCreateFromConstructor reads nothing a program can observe
 *   (`X.prototype` is read only and non-configurable), so creating the object after ToString is the same;
 *   ToString(message) runs once and only for a message that is not `undefined` (the program's `stringOf`: a message
 *   object's `toString` is called, and its throw is catchable); the realm's `js.object.create-error` defines `message`
 *   (or none). A call and a construct answer alike (step 1: NewTarget is the active function). A second argument
 *   (ES2022 `options`, whose `cause` InstallErrorCause reads) refuses by name.
 * - A wrapper constructor (§22.1.1.1, §21.1.1.1, §20.3.1.1): the call is the conversion of its first argument (none:
 *   "", +0, false), ToString / ToNumber / ToBoolean, the program's own (an object argument's ToPrimitive runs once);
 *   the construct is that conversion, then `js.object.create-wrapper` (the wrapper's [[Prototype]] is the constructor's
 *   read-only `prototype`, so the realm reads it).
 * - `Object` (§20.1.1.1, NewTarget `Object` itself or undefined): `undefined`, `null` or no argument answer a new
 *   ordinary object; an object or a function answers itself; a primitive answers its wrapper (ToObject).
 * - (#7354 A1) `Array` (§23.1.1.1; a call and a construct alike): no argument an empty array; one number argument
 *   ArrayCreate of it (the realm's RangeError for a number that is no array length); one argument of any other kind,
 *   or several, an array of them.
 *
 * Premise re-proof. C2's `instanceof` and P1's `isPrototypeOf` answer `false` for a function's chain because it holds
 * only realm objects no program obtains. With the Error family held, `%Error%` is a value and a NativeError
 * constructor's [[Prototype]] (§20.5.6.2); (W2) with `Object` held, %Object.prototype% is a value and the end of every
 * function's chain. So where either is held a function's chain answers `true` for %Object.prototype%, the run-time
 * abort for `%Error%` (`F.prototype = Error; TypeError instanceof F`), and `false` for every other prototype
 * ({@link functionChainAnswer}).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { NativeWrapperConstructor } from "../../runtime/contracts/native-realm-catalog.js";
import type { IrType } from "../core/types.js";
import {
  ARRAY_ID,
  NATIVE_WRAPPER_CONSTRUCTORS,
  WRAPPER_OF_PRIMITIVE,
  ERROR_ID,
  errorConstructorName,
  errorConstructorSelector,
  wrapperConstructorSelector,
} from "./builtin-prototype-keys.js";
import { realmCall, realmIntrinsicOfHelper } from "./dynamic-realm-calls.js";
import { FULL_DATA_DESCRIPTOR } from "../../shared/contracts/descriptor-word.js";
import type { ChainBuilders, ConvertingBuilders } from "./dynamic-value-chains.js";
import { BOOLEAN, CARRIER, F64, carried } from "./dynamic-value-types.js";
import { gap } from "./dynamic-value-gap.js";
import { MEMBER_ACCESS_ARM, type CarrierKind } from "./dynamic-value-kinds.js";

type Call = Extract<IrInstr, { kind: "call" }>;
type Construct = Extract<IrInstr, { kind: "dyn.construct" }>;
type Arm = (result: IrValueId) => IrInstr[];

/** The realm constructor `callee` is (its catalog id), when its definition is the front end's read of one. */
export function realmConstructorOf(
  callee: IrValueId,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): string | undefined {
  let definition = definitions.get(callee);
  while (definition?.kind === "coerce.to_externref") definition = definitions.get(definition.value);
  const id =
    definition?.kind === "call" && definition.target.binding.kind === "runtime"
      ? realmIntrinsicOfHelper(definition.target.binding.symbol)
      : undefined;
  return id !== undefined && isRealmConstructor(id) ? id : undefined;
}

const isRealmConstructor = (id: string): boolean =>
  id === "%Object%" || id === ARRAY_ID || errorConstructorSelector(id) >= 0 || wrapperConstructorSelector(id) >= 0;

/** `X(…args)` (`construct` false) or `new X(…args)` of the realm constructor `id`, into the instruction's result. */
export function dynamicRealmConstruction(
  b: ConvertingBuilders,
  instr: Call | Construct,
  id: string,
  args: readonly IrValueId[],
  construct: boolean,
): IrInstr[] {
  const error = errorConstructorSelector(id);
  if (error >= 0) return errorConstruction(b, instr, error, args);
  if (id === "%Object%") return objectConstruction(b, instr, args[0]);
  if (id === ARRAY_ID) return arrayConstruction(b, instr, args);
  const selector = wrapperConstructorSelector(id);
  const conversion = CONVERSION[NATIVE_WRAPPER_CONSTRUCTORS[selector]!];
  const primitive = (r: IrValueId): IrInstr[] =>
    args[0] === undefined ? conversion.absent(b, instr, r) : conversion.convert(b, instr, args[0], r);
  if (!construct) return primitive(instr.result!);
  const value = b.fresh();
  return [...primitive(value), ...b.selectorCall("js.object.create-wrapper", [value], selector, instr.result!)];
}

/** `create` of the message `undefined` (none, a null reference) or of ToString(message), per the message's kind. */
function errorConstruction(b: ConvertingBuilders, instr: IrInstr, selector: number, args: readonly IrValueId[]) {
  if (args.length > 1) gap(`${errorConstructorName(selector)} with a second argument (options.cause)`);
  const message = args[0];
  const create = (value: IrValueId, r: IrValueId) => b.selectorCall("js.object.create-error", [value], selector, r);
  const none = (r: IrValueId): IrInstr[] => {
    const absent = b.fresh();
    return [
      { kind: "const", value: { kind: "null", ty: CARRIER }, result: absent, resultType: CARRIER },
      ...create(absent, r),
    ];
  };
  const converted = (r: IrValueId): IrInstr[] => {
    const [text, value] = [b.fresh(), b.fresh()];
    return [...b.stringOf(instr, message!, text), carried(text, value), ...create(value, r)];
  };
  return withUndefined(b, instr, message, none, converted);
}

/** `arm` for `value`, but `absent` where it is missing or may be `undefined` (tested once). */
function withUndefined(
  b: ChainBuilders,
  instr: IrInstr,
  value: IrValueId | undefined,
  absent: Arm,
  arm: Arm,
): IrInstr[] {
  if (value === undefined) return absent(instr.result!);
  if (!b.kinds.kindsOf(value).includes("undefined")) return arm(instr.result!);
  const isUndefined = b.fresh();
  return [
    ...b.anyKind(instr, ["undefined"], value, isUndefined),
    b.branch(isUndefined, absent, arm, instr.result!, CARRIER),
  ];
}

/**
 * Each wrapper constructor's conversion (§22.1.1.1 ToString, §21.1.1.1 ToNumber, §20.3.1.1 ToBoolean) of `value`, and
 * its value for no argument ("", +0, false), into the carrier primitive `result`.
 */
const CONVERSION: Readonly<
  Record<
    NativeWrapperConstructor,
    {
      readonly convert: (b: ConvertingBuilders, instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
      readonly absent: (b: ConvertingBuilders, instr: IrInstr, result: IrValueId) => IrInstr[];
    }
  >
> = {
  String: {
    convert: (b, instr, value, r) => {
      const text = b.fresh();
      return [...b.stringOf(instr, value, text), carried(text, r)];
    },
    absent: (b, _instr, r) => {
      const text = b.fresh();
      return [b.text("", text), carried(text, r)];
    },
  },
  Number: {
    convert: (b, instr, value, r) => {
      const number = b.fresh();
      return [...b.toNumber(instr, value, number), b.intrinsic(instr, "js.number.box", [number], r)];
    },
    absent: (b, instr, r) => {
      const number = b.fresh();
      return [
        { kind: "const", value: { kind: "f64", value: 0 }, result: number, resultType: F64 },
        b.intrinsic(instr, "js.number.box", [number], r),
      ];
    },
  },
  Boolean: {
    convert: (b, instr, value, r) => {
      const flag = b.fresh();
      return [
        b.intrinsic(instr, "js.value.to_boolean", [value], flag),
        b.intrinsic(instr, "js.boolean.box", [flag], r),
      ];
    },
    absent: (b, instr, r) => {
      const flag = b.fresh();
      return [
        { kind: "const", value: { kind: "bool", value: false }, result: flag, resultType: BOOLEAN },
        b.intrinsic(instr, "js.boolean.box", [flag], r),
      ];
    },
  },
};

/** `Object(value)`: a new object for nothing, `undefined` or `null`; an object itself; a primitive's wrapper. */
function objectConstruction(b: ConvertingBuilders, instr: IrInstr, value: IrValueId | undefined): IrInstr[] {
  const create: Arm = (r) => [realmCall("js.object.create-default", [], r)];
  if (value === undefined) return create(instr.result!);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    if (MEMBER_ACCESS_ARM[kind] === "type-error") return create(r);
    const wrapper = WRAPPER_OF_PRIMITIVE[kind as keyof typeof WRAPPER_OF_PRIMITIVE];
    return wrapper === undefined
      ? [carried(value, r)]
      : b.selectorCall("js.object.create-wrapper", [value], NATIVE_WRAPPER_CONSTRUCTORS.indexOf(wrapper), r);
  };
  return b.kindChain(instr, value, instr.result!, arm, b.kinds.kindsOf(value), CARRIER);
}

/** `Array(…args)` / `new Array(…args)` into the instruction's result (§23.1.1.1). */
function arrayConstruction(b: ConvertingBuilders, instr: IrInstr, args: readonly IrValueId[]): IrInstr[] {
  const dense = (r: IrValueId): IrInstr[] => {
    const length = b.fresh();
    const keys = args.map(() => [b.fresh(), b.fresh()] as const);
    return [
      { kind: "const", value: { kind: "f64", value: args.length }, result: length, resultType: F64 },
      ...keys.flatMap(([text, key], index) => [b.text(String(index), text), carried(text, key)]),
      ...arrayOf(
        b,
        length,
        keys.map(([, key], index) => [key, args[index]!] as const),
        r,
      ),
    ];
  };
  if (args.length !== 1) return dense(instr.result!);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    if (kind !== "number") return dense(r);
    const length = b.fresh();
    return [...b.toNumber(instr, args[0]!, length), realmCall("js.object.create-array", [length], r)];
  };
  return b.kindChain(instr, args[0]!, instr.result!, arm, b.kinds.kindsOf(args[0]!), CARRIER);
}

/** (#7354 A1) The front end's array literal helper call (`ARRAY_LITERAL_HELPER`): its length, then key-value pairs. */
export function arrayLiteral(b: ChainBuilders, instr: Extract<IrInstr, { kind: "call" }>): IrInstr[] {
  const [length, ...pairs] = instr.args;
  const entries = Array.from({ length: pairs.length / 2 }, (_, at): readonly [IrValueId, IrValueId] => [
    pairs[2 * at]!,
    pairs[2 * at + 1]!,
  ]);
  return arrayOf(b, length!, entries, instr.result!);
}

/**
 * (#7354 A1) ArrayCreate(`length`), then each value of `entries` CreateDataPropertyOrThrow under its key (§13.2.4.1
 * ArrayAccumulation, §23.1.1.1 step 7), into `r`: an array literal (whose elements the front end evaluated in source
 * order; defining them after is the same, since a fresh array runs no program code on a define) and `Array(…values)`.
 */
function arrayOf(
  b: ChainBuilders,
  length: IrValueId,
  entries: readonly (readonly [key: IrValueId, value: IrValueId])[],
  r: IrValueId,
): IrInstr[] {
  return [
    realmCall("js.object.create-array", [length], r),
    ...entries.flatMap(([key, value]): IrInstr[] => {
      const word = b.fresh();
      return [
        { kind: "const", value: { kind: "f64", value: FULL_DATA_DESCRIPTOR }, result: word, resultType: F64 },
        realmCall("js.object.define-data", [r, key, value, word]),
      ];
    }),
  ];
}

/**
 * The answer of a walk over a function's [[Prototype]] chain for `prototype` (OrdinaryHasInstance's step 6,
 * isPrototypeOf's step 3): `no` (false), but where `families.errors` and `prototype` is `%Error%` the run-time abort,
 * which ends the program before the arm's own (unread) answer, and (W2) where `families.prototypes` `yes` for
 * %Object.prototype% (module doc).
 */
export function functionChainAnswer(
  b: ChainBuilders,
  instr: IrInstr,
  prototype: IrValueId,
  no: Arm,
  yes: Arm,
  r: IrValueId,
  resultType: IrType,
): IrInstr[] {
  const test =
    (id: string, then: Arm, otherwise: Arm): Arm =>
    (s) => {
      const [value, same] = [b.fresh(), b.fresh()];
      return [
        ...b.realmIntrinsic(id, value),
        b.intrinsic(instr, "js.value.strict_eq", [prototype, value], same),
        b.branch(same, then, otherwise, s, resultType),
      ];
    };
  const errors: Arm = b.families.errors ? test(ERROR_ID, (s) => [...b.abort(instr, b.fresh()), ...no(s)], no) : no;
  return (b.families.prototypes ? test("%Object.prototype%", yes, errors) : errors)(r);
}
