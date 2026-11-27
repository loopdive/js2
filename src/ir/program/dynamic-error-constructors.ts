// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1) The Error family on the dynamic-value legalization.
 *
 * Construction. `X(m)` and `new X(m)` with `X` the unchanged global Error constructor lower as F2's call and C2's
 * `dyn.construct` through the identifier's value, which is the realm's `js.object.intrinsic(<X>)`
 * (`identifier-read.ts` proves the global pristine). A call or construct whose callee is that value is §20.5.1.1 /
 * §20.5.6.1.1 here: the arguments are already evaluated (the front end, left to right); OrdinaryCreateFromConstructor
 * reads nothing a program can observe (`X.prototype` is read only and non-configurable), so creating the object after
 * ToString is the same; ToString(message) runs once and only for a message that is not `undefined` (the program's
 * `stringOf`: a message object's `toString` is called, and its throw is catchable); the realm's `js.object.create-error`
 * defines `message` (or none). A call and a construct answer alike (step 1: NewTarget is the active function). A second
 * argument (ES2022 `options`, whose `cause` InstallErrorCause reads) refuses by name. Any other callee holding the
 * constructor (through a variable) reaches the dispatcher, whose built-in arm is the run-time abort.
 *
 * Premise re-proof. C2's `instanceof` and P1's `isPrototypeOf` answer `false` for a function's chain because it holds
 * only realm objects no program obtains. With the Error family held, `%Error%` is a value and a NativeError
 * constructor's [[Prototype]] (§20.5.6.2): so where a value may be an error, a function's chain answers `false` unless
 * the prototype sought is `%Error%`, which is the run-time abort ({@link functionChainAnswer}); `%Error%` is the one
 * value on a function's chain a program can hold (`F.prototype = Error; TypeError instanceof F`).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { ERROR_ID, OBJECT_PROTOTYPE_ID, type RealmConstructor } from "./builtin-prototype-keys.js";
import { builtinMethodChain, identityTest } from "./dynamic-builtin-methods.js";
import { holdsFamily, type LegalizationProgram } from "./dynamic-value-kinds.js";
import { BOOLEAN } from "./dynamic-value-types.js";
import type { IrType } from "../core/types.js";
import { CARRIER, carried, type ChainBuilders } from "./dynamic-value-chains.js";
import type { RealmConstruction, RealmConstructionBuilders } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";

/** `X(message)` / `new X(message)` of the Error constructor `ctor`, into the instruction's result. */
export function dynamicErrorConstruction(
  b: RealmConstructionBuilders,
  instr: RealmConstruction,
  ctor: RealmConstructor<"error">,
  args: readonly IrValueId[],
): IrInstr[] {
  if (args.length > 1) gap(`${ctor.name} with a second argument (options.cause)`);
  const message = args[0];
  const create = (value: IrValueId, r: IrValueId) =>
    b.selectorCall("js.object.create-error", [value], ctor.selector, r);
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
  if (message === undefined) return none(instr.result!);
  const held = b.kinds.kindsOf(message);
  if (!held.includes("undefined")) return converted(instr.result!);
  const isUndefined = b.fresh();
  return [
    ...b.anyKind(instr, ["undefined"], message, isUndefined),
    b.branch(isUndefined, none, converted, instr.result!, CARRIER),
  ];
}

/**
 * The answer of a walk over a function's [[Prototype]] chain for `prototype` (OrdinaryHasInstance's step 6,
 * isPrototypeOf's step 3): `no` (false), but (#7574) `true` where the program holds the Object family and `prototype`
 * is the realm's root, which ends every function's chain, and where the program holds the Error family and
 * `prototype` is `%Error%` the run-time abort, which ends the program before the arm's own (unread) answer (module
 * doc).
 */
export function functionChainAnswer(
  b: ChainBuilders,
  instr: IrInstr,
  program: LegalizationProgram,
  prototype: IrValueId,
  no: (r: IrValueId) => IrInstr[],
  r: IrValueId,
  resultType: IrType,
): IrInstr[] {
  const yes = (s: IrValueId): IrInstr[] => [
    { kind: "const", value: { kind: "bool", value: true }, result: s, resultType: BOOLEAN },
  ];
  const tests = [
    ...(holdsFamily(program, "object") ? [() => identityTest(b, instr, OBJECT_PROTOTYPE_ID, prototype, yes)] : []),
    ...(holdsFamily(program, "error")
      ? [() => identityTest(b, instr, ERROR_ID, prototype, (s) => [...b.abort(instr, b.fresh()), ...no(s)])]
      : []),
  ];
  return builtinMethodChain(b, tests, no, resultType)(r);
}
