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
 *
 * Premise re-proof. C2's `instanceof` and P1's `isPrototypeOf` answer `false` for a function's chain because it holds
 * only realm objects no program obtains. With the Error family held, `%Error%` is a value and a NativeError
 * constructor's [[Prototype]] (§20.5.6.2); (W2) with `Object` held, %Object.prototype% is a value and the end of every
 * function's chain. So where either is held a function's chain answers `true` for %Object.prototype%, the run-time
 * abort for `%Error%` (`F.prototype = Error; TypeError instanceof F`), and `false` for every other prototype
 * ({@link functionChainAnswer}).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import {
  ERROR_ID,
  errorConstructorName,
  errorConstructorSelector,
  wrapperConstructorSelector,
} from "./builtin-prototype-keys.js";
import { realmCall, realmIntrinsicOfHelper } from "./dynamic-realm-calls.js";
import { CARRIER, carried, type ChainBuilders } from "./dynamic-value-chains.js";
import { gap } from "./dynamic-value-gap.js";
import { MEMBER_ACCESS_ARM, type CarrierKind } from "./dynamic-value-kinds.js";

type Call = Extract<IrInstr, { kind: "call" }>;
type Construct = Extract<IrInstr, { kind: "dyn.construct" }>;
export type RealmConstructorBuilders = ChainBuilders & {
  readonly stringOf: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
  readonly toNumber: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
};
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
  return id !== undefined &&
    (id === "%Object%" || errorConstructorSelector(id) >= 0 || wrapperConstructorSelector(id) >= 0)
    ? id
    : undefined;
}

/** `X(…args)` (`construct` false) or `new X(…args)` of the realm constructor `id`, into the instruction's result. */
export function dynamicRealmConstruction(
  b: RealmConstructorBuilders,
  instr: Call | Construct,
  id: string,
  args: readonly IrValueId[],
  construct: boolean,
): IrInstr[] {
  const error = errorConstructorSelector(id);
  if (error >= 0) return errorConstruction(b, instr, error, args);
  if (id === "%Object%") return objectConstruction(b, instr, args[0]);
  const selector = wrapperConstructorSelector(id);
  const primitive = wrapperPrimitive(b, instr, selector, args[0]);
  if (!construct) return primitive(instr.result!);
  const value = b.fresh();
  return [...primitive(value), ...b.selectorCall("js.object.create-wrapper", [value], selector, instr.result!)];
}

/** The carrier `undefined` into `result`. */
const undefinedValue =
  (b: ChainBuilders, instr: IrInstr): Arm =>
  (r) => [b.intrinsic(instr, "js.value.undefined", [], r)];

/** `create` of the message `undefined` (none, a null reference) or of ToString(message), per the message's kind. */
function errorConstruction(b: RealmConstructorBuilders, instr: IrInstr, selector: number, args: readonly IrValueId[]) {
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

/** The wrapper constructor `selector`'s conversion of `value` (none: its default), a carrier primitive. */
function wrapperPrimitive(b: RealmConstructorBuilders, instr: IrInstr, selector: number, value: IrValueId | undefined) {
  return (r: IrValueId): IrInstr[] => {
    const converted = b.fresh();
    switch (selector) {
      case 0:
        return value === undefined
          ? [b.text("", converted), carried(converted, r)]
          : [...b.stringOf(instr, value, converted), carried(converted, r)];
      case 1:
        return value === undefined
          ? [
              { kind: "const", value: { kind: "f64", value: 0 }, result: converted, resultType: F64 },
              b.intrinsic(instr, "js.number.box", [converted], r),
            ]
          : [...b.toNumber(instr, value, converted), b.intrinsic(instr, "js.number.box", [converted], r)];
      default:
        return value === undefined
          ? [
              { kind: "const", value: { kind: "bool", value: false }, result: converted, resultType: BOOLEAN },
              b.intrinsic(instr, "js.boolean.box", [converted], r),
            ]
          : [
              b.intrinsic(instr, "js.value.to_boolean", [value], converted),
              b.intrinsic(instr, "js.boolean.box", [converted], r),
            ];
    }
  };
}
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** The wrapper constructor of each primitive kind (`NATIVE_WRAPPER_CONSTRUCTORS` order). */
const WRAPPER_OF: Readonly<Partial<Record<CarrierKind, number>>> = { string: 0, number: 1, boolean: 2 };

/** `Object(value)`: a new object for nothing, `undefined` or `null`; an object itself; a primitive's wrapper. */
function objectConstruction(b: RealmConstructorBuilders, instr: IrInstr, value: IrValueId | undefined): IrInstr[] {
  const create: Arm = (r) => [realmCall("js.object.create-default", [], r)];
  if (value === undefined) return create(instr.result!);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    if (MEMBER_ACCESS_ARM[kind] === "type-error") return create(r);
    const wrapper = WRAPPER_OF[kind];
    return wrapper === undefined
      ? [carried(value, r)]
      : b.selectorCall("js.object.create-wrapper", [value], wrapper, r);
  };
  return b.kindChain(instr, value, instr.result!, arm, b.kinds.kindsOf(value), CARRIER);
}

/**
 * The answer of a walk over a function's [[Prototype]] chain for `prototype` (OrdinaryHasInstance's step 6,
 * isPrototypeOf's step 3): `no` (false), but where `errors` and `prototype` is `%Error%` the run-time abort, which ends
 * the program before the arm's own (unread) answer, and (W2) where `objects` (the program holds `Object`) `yes` for
 * %Object.prototype% (module doc).
 */
export function functionChainAnswer(
  b: ChainBuilders,
  instr: IrInstr,
  held: { readonly errors: boolean; readonly objects: boolean },
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
  const errors: Arm = held.errors ? test(ERROR_ID, (s) => [...b.abort(instr, b.fresh()), ...no(s)], no) : no;
  return (held.objects ? test("%Object.prototype%", yes, errors) : errors)(r);
}
