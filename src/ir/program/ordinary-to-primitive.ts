// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2b, F1, F2) OrdinaryToPrimitive (§7.1.1.1) of the object and function kinds, decided at run time: the one
 * builder ToString, ToNumber and `+` share (`TO_STRING_ARM`, `TO_NUMBER_ARM`, `ADD_ROLE`).
 *
 * For each name in hint order the method is Got; a callable one is called with the object as `this` (the native
 * dispatcher, `js.closure.call:0`) and its result answers if it is a primitive, and a non-callable one is skipped
 * (step 2.b). A method the object does not hold is the realm's: Object.prototype's `valueOf` answers the object (not a
 * primitive, so it is skipped too: the realm's Get answers `undefined` for it, which is skipped the same way) and its
 * `toString` "[object Object]"; (F1b) a function's absent `toString` is Function.prototype.toString, the source text the
 * closure does not carry, which the caller answers (`ToPrimitiveAnswer.text`). In a program that creates no function
 * value no method can be callable, so only `toString` is consulted. `@@toPrimitive` (§7.1.1 step 2) is reachable only
 * by naming `Symbol`, and such a program refuses by name. (#7354 G1) An error's `toString` is the realm's
 * Error.prototype.toString, which the dispatcher cannot call: recognised by identity and answered here.
 */
import type { IrInstr, IrType, IrValueId } from "../core/nodes.js";
import { irClosureMethodReference } from "../core/closure-invocation-callables.js";
import type { LegalizationProgram } from "./dynamic-value-kinds.js";
import { realmCall, textKey, typeError, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";

/** ToPrimitive's hint: `string` for ToString, `number` for ToNumber and (as `default`) for `+`. */
export type ToPrimitiveHint = "string" | "number";

/** What the caller makes of the primitive (ToString's string, ToNumber's number, or `+`'s carrier value). */
export interface ToPrimitiveAnswer {
  readonly type: IrType;
  /**
   * The answer from a built-in `toString`'s text: Object.prototype's, or (`undefined`) Function.prototype's source
   * text. Also the never-produced value of the TypeError arm (`""`).
   */
  readonly text: (value: string | undefined, result: IrValueId) => IrInstr[];
  /** The answer from the primitive a source method returned, a carrier value of a primitive kind. */
  readonly primitive: (value: IrValueId, result: IrValueId) => IrInstr[];
}

/** The builders OrdinaryToPrimitive is written with. */
export interface ToPrimitiveBuilders extends TypeErrorBuilders {
  readonly branch: (
    cond: IrValueId,
    then: (result: IrValueId) => IrInstr[],
    else_: (result: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType: IrType,
  ) => IrInstr;
  /** Where the program creates function values: `js.value.is_function` of `value` into `result`. */
  readonly isCallable: ((value: IrValueId, result: IrValueId) => IrInstr) | undefined;
  /** Whether the carrier `value` holds a primitive (none of the program's object kinds), into `result`. */
  readonly isPrimitive: (value: IrValueId, result: IrValueId) => IrInstr[];
  /**
   * (#7354 G1) Where a value may be an error: whether `method` is the realm's Error.prototype.toString, into `result`,
   * and its answer for `object` (`js.object.error-to-string`): a built-in the dispatcher cannot call, written here.
   */
  readonly errorToString?: {
    readonly is: (method: IrValueId, result: IrValueId) => IrInstr[];
    readonly answer: (object: IrValueId, result: IrValueId) => IrInstr[];
  };
  /**
   * (#7354 G1) Where the program creates no source function, every callable method is a built-in, which the
   * dispatcher could only abort for: the run-time abort itself, as a carrier answer.
   */
  readonly builtinOnly?: (result: IrValueId) => IrInstr[];
}

/**
 * OrdinaryToPrimitive of the once-evaluated `object` (an ordinary object, or (F1b) a function value) with `hint`: the
 * caller's `answer` of the primitive into `result`, or a TypeError.
 */
export function ordinaryToPrimitive(
  b: ToPrimitiveBuilders,
  program: LegalizationProgram,
  object: IrValueId,
  hint: ToPrimitiveHint,
  result: IrValueId,
  kind: "object" | "function",
  answer: ToPrimitiveAnswer,
): IrInstr[] {
  if (program.objects.namesSymbol) gap("ToPrimitive of an object in a program that names 'Symbol'");
  // Without a callable kind `valueOf` is skipped whether held or not, so it is not consulted at all: the answers are
  // the same, and a program without function values keeps the bytes it had before F1.
  const names = !b.isCallable ? ["toString"] : hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  // The method `names[index]` and the ones after it, into `r`.
  const step = (index: number, r: IrValueId): IrInstr[] => {
    const name = names[index];
    // The TypeError does not complete; the text only gives the arm its value.
    if (name === undefined) return [...typeError(b, "Cannot convert object to primitive value"), ...answer.text("", r)];
    const key = b.fresh();
    const next = (s: IrValueId) => step(index + 1, s);
    const method = (s: IrValueId) => callIfCallable(b, object, key, answer, next, s);
    const named: IrInstr[] = textKey(b, name, key);
    if (name !== "toString") return [...named, ...method(r)];
    // Only an absent `toString` has an answer of its own; an absent `valueOf` is skipped like any non-callable one.
    const held = b.fresh();
    const absent = (s: IrValueId) => answer.text(kind === "object" ? "[object Object]" : undefined, s);
    return [...named, realmCall("js.object.has", [object, key], held), b.branch(held, method, absent, r, answer.type)];
  };
  return step(0, result);
}

/**
 * A method `key` of `object`: (#7354 F2) a callable one is called with the object as `this`, and a primitive result
 * answers; a non-callable method (the object stands in for its result) or an object result goes on to the next name.
 */
function callIfCallable(
  b: ToPrimitiveBuilders,
  object: IrValueId,
  key: IrValueId,
  answer: ToPrimitiveAnswer,
  next: (result: IrValueId) => IrInstr[],
  result: IrValueId,
): IrInstr[] {
  if (!b.isCallable) return next(result);
  const [method, callable, value, primitive] = [b.fresh(), b.fresh(), b.fresh(), b.fresh()];
  const dispatch = (r: IrValueId): IrInstr[] =>
    b.builtinOnly
      ? b.builtinOnly(r)
      : [
          {
            kind: "call",
            target: irClosureMethodReference(0),
            args: [object, method],
            result: r,
            resultType: b.carrier,
          },
        ];
  const builtin = b.errorToString;
  const call = (r: IrValueId): IrInstr[] => {
    if (!builtin) return dispatch(r);
    const same = b.fresh();
    return [...builtin.is(method, same), b.branch(same, (s) => builtin.answer(object, s), dispatch, r, b.carrier)];
  };
  const skip = (r: IrValueId): IrInstr[] => [
    { kind: "coerce.to_externref", value: object, result: r, resultType: b.carrier },
  ];
  return [
    realmCall("js.object.get", [object, key, object], method),
    b.isCallable(method, callable),
    b.branch(callable, call, skip, value, b.carrier),
    ...b.isPrimitive(value, primitive),
    b.branch(primitive, (r) => answer.primitive(value, r), next, result, answer.type),
  ];
}
