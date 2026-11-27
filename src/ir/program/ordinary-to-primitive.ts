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
 * Error.prototype.toString, which the dispatcher cannot call: recognised by identity and answered here; (#7561) so are
 * a wrapper's `valueOf` and `toString` (`dynamic-builtin-methods.ts`).
 */
import type { IrInstr, IrType, IrValueId } from "../core/nodes.js";
import { irClosureMethodReference } from "../core/closure-invocation-callables.js";
import type { LegalizationProgram } from "./dynamic-value-kinds.js";
import { realmCall, typeError, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";
import { builtinMethodChain, type BuiltinMethodTest } from "./dynamic-builtin-methods.js";

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
  /** (#7354 A1) The run-time abort, as the answer it never produces: the abort's text is the answer's operand. */
  readonly unsupported: (result: IrValueId) => IrInstr[];
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
   * (#7354 G1, #7561) The realm's conversion methods a method read under `name` may be (`conversionMethodTests`):
   * built-ins the dispatcher cannot call, each tested on the method read and answered here.
   */
  readonly builtins: (name: string, method: IrValueId, object: IrValueId) => readonly (() => BuiltinMethodTest)[];
  /**
   * (#7354 G1) Where the program creates no source function, every callable method is a built-in, which the
   * dispatcher could only abort for: the run-time abort itself, as a carrier answer.
   */
  readonly builtinOnly?: (result: IrValueId) => IrInstr[];
  /** (#7354 A1) Where the program holds arrays: whether `object` is one (its brand), into the i32 `result`. */
  readonly isArray?: (object: IrValueId, result: IrValueId) => IrInstr[];
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
    const [text, key] = [b.fresh(), b.fresh()];
    const next = (s: IrValueId) => step(index + 1, s);
    const method = (s: IrValueId) => callIfCallable(b, name, object, key, answer, next, s);
    const named: IrInstr[] = [
      b.text(name, text),
      { kind: "coerce.to_externref", value: text, result: key, resultType: b.carrier },
    ];
    if (name !== "toString") return [...named, ...method(r)];
    // Only an absent `toString` has an answer of its own; an absent `valueOf` is skipped like any non-callable one.
    const held = b.fresh();
    const absent = (s: IrValueId) => answer.text(kind === "object" ? "[object Object]" : undefined, s);
    return [...named, realmCall("js.object.has", [object, key], held), b.branch(held, method, absent, r, answer.type)];
  };
  // (#7352) An array's `toString` is Array.prototype's (`join`), which the realm does not hold yet: whatever
  // its chain holds (a program may write Object.prototype's `toString` / `valueOf`), an array aborts before any read.
  const isArray = kind === "object" ? b.isArray : undefined;
  if (!isArray) return step(0, result);
  const array = b.fresh();
  return [...isArray(object, array), b.branch(array, answer.unsupported, (r) => step(0, r), result, answer.type)];
}

/**
 * A method `key` of `object`: (#7354 F2) a callable one is called with the object as `this`, and a primitive result
 * answers; a non-callable method (the object stands in for its result) or an object result goes on to the next name.
 */
function callIfCallable(
  b: ToPrimitiveBuilders,
  name: string,
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
  const call = builtinMethodChain(b, b.builtins(name, method, object), dispatch, b.carrier);
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
