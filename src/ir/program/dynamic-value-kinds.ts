// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 D1, Ty, Str2, Str2-c, O2, O2b, F1, G1) The kinds of value the Prepared dynamic value admits, and how each operation
 * of the dynamic-value legalization answers each kind. Every table is a `Record` over `CarrierKind`, so a slice that
 * admits a kind must give it a row in each.
 *
 * Soundness rests on the admitted set: the box arm admits a value only as one of these kinds (`carrierKindOf`), so a
 * test that rules out every other kind proves the last one (`complement`), and a chain over all kinds may leave the
 * last kind untested (`KIND_ORDER`).
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrType, IrValueId } from "../core/nodes.js";
import type { TagId } from "../core/tag-domain.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";
import { functionValueOperand } from "./function-value-projection.js";
import { isArrayLiteralCall } from "./dynamic-realm-calls.js";
import { ARRAY_ID, errorConstructorSelector, WRAPPER_IDS } from "./builtin-prototype-keys.js";

/**
 * `typeof`'s answer for each kind. A `typeof` comparison with a literal no kind answers (a typo) is constant false;
 * `typeof null` and an object both answer "object"; (F1) a function value "function".
 */
export const TYPEOF_NAME = {
  number: "number",
  boolean: "boolean",
  string: "string",
  undefined: "undefined",
  null: "object",
  function: "function",
  object: "object",
} as const;
export type CarrierKind = keyof typeof TYPEOF_NAME;
/** The kinds each `typeof` answer stands for: `TYPEOF_NAME` read backwards. */
export const KINDS_OF_TYPEOF: ReadonlyMap<string, readonly CarrierKind[]> = new Map(
  [...new Set(Object.values(TYPEOF_NAME))].map((answer) => [
    answer,
    (Object.keys(TYPEOF_NAME) as CarrierKind[]).filter((kind) => TYPEOF_NAME[kind] === answer),
  ]),
);

/**
 * How the carrier tests for each kind: a runtime predicate ((F1) a function value's is a source closure's wrapper
 * root), the null test, or (an ordinary object, (#7354 G1) an error included) none of the other kinds' tests.
 */
export const KIND_TEST: Readonly<Record<CarrierKind, IntrinsicId | "ref.is_null" | "complement">> = {
  number: "js.value.is_number",
  boolean: "js.value.is_boolean",
  string: "js.value.is_string",
  undefined: "js.extern.is_undefined",
  null: "ref.is_null",
  function: "js.value.is_function",
  object: "complement",
};

/**
 * How ToString (§7.1.17) answers each kind, in the order a chain tests them: the native string it carries, the number
 * formatter, "true"/"false", the kind's own name, or (O2b) an object's ((#7354 G1) an error's too) and (F2) a
 * function's OrdinaryToPrimitive (`ordinary-to-primitive.ts`), which calls an own conversion method; a
 * function's absent `toString` is Function.prototype.toString, its source text, which no closure carries (the
 * run-time abort). The last kind is reached untested because the chain is total over this table; an object stays
 * last, the complement of the others.
 */
export const TO_STRING_ARM: Readonly<
  Record<CarrierKind, "as-string" | "format" | "boolean" | "name" | "to-primitive">
> = {
  string: "as-string",
  number: "format",
  boolean: "boolean",
  undefined: "name",
  null: "name",
  function: "to-primitive",
  object: "to-primitive",
};
export const KIND_ORDER = Object.keys(TO_STRING_ARM) as readonly CarrierKind[];

/**
 * How `+` (§13.15.3) takes each kind: a string makes the addition a concatenation, and any other primitive is summed
 * through ToNumber; (F2) an object's and a function's role is their ToPrimitive's (`ordinary-to-primitive.ts`), taken
 * first.
 */
export const ADD_ROLE: Readonly<Record<CarrierKind, "concat" | "numeric" | "to-primitive">> = {
  number: "numeric",
  boolean: "numeric",
  string: "concat",
  undefined: "numeric",
  null: "numeric",
  function: "to-primitive",
  object: "to-primitive",
};

/**
 * (#7354 F2) Whether each kind's values are objects: a conversion method's result of such a kind does not answer
 * ToPrimitive, which goes on to the next method (§7.1.1.1 step 2.b.ii).
 */
export const IS_OBJECT: Readonly<Record<CarrierKind, boolean>> = {
  number: false,
  boolean: false,
  string: false,
  undefined: false,
  null: false,
  function: true,
  object: true,
};

/**
 * How ToNumber (§7.1.4) answers each kind: the primitive unboxer (a number its payload, a Boolean 0/1, `undefined`
 * NaN, `null` 0), or (O2b) an object's ToPrimitive, whose string reads as a number. (F1b) A function's is its
 * ToPrimitive too: an own `valueOf` or `toString` may answer, and without one it is the source text, which reads as NaN.
 */
export const TO_NUMBER_ARM: Readonly<Record<CarrierKind, "unbox" | "to-primitive">> = {
  number: "unbox",
  boolean: "unbox",
  string: "unbox",
  undefined: "unbox",
  null: "unbox",
  function: "to-primitive",
  object: "to-primitive",
};

/**
 * (#7354 M1, B-tag) `Object.prototype.toString`'s tag for each kind (§20.1.3.6): `undefined` and `null` are named
 * before ToObject (steps 1-2), a primitive answers its wrapper's builtinTag, and an ordinary object "Object" ((#7354 G1)
 * "Error" where it has [[ErrorData]], step 9), its `@@toStringTag` reachable only by naming `Symbol`.
 */
export const OBJECT_TAG: Readonly<Record<CarrierKind, string>> = {
  number: "Number",
  boolean: "Boolean",
  string: "String",
  undefined: "Undefined",
  null: "Null",
  function: "Function",
  object: "Object",
};

/**
 * (#7354 O4, O3) How a member read (GetValue) and a member write (PutValue) take each receiver
 * kind: both ToObject the base, so `undefined` and `null` throw a TypeError; an object is the realm's [[Get]] or
 * [[Set]]; a primitive reaches only built-in prototypes (`builtin-prototype-keys.ts`), which no Prepared program can
 * obtain to change (M1, C1); (F1b) a function value is the realm's [[Get]] / [[Set]] on its closure, whose own `length` and `name` are read only.
 */
export const MEMBER_ACCESS_ARM: Readonly<Record<CarrierKind, "type-error" | "object" | "primitive" | "function">> = {
  number: "primitive",
  boolean: "primitive",
  string: "primitive",
  undefined: "type-error",
  null: "type-error",
  function: "function",
  object: "object",
};

/**
 * (#7354 C2) Whether a kind's values are ordinary objects of the realm's layout: the kind whose member access is the
 * realm's ordinary [[Get]] / [[Set]] (`MEMBER_ACCESS_ARM` "object"). Their [[Prototype]] links are ordinary objects too
 * (`create-default`, `create-with-prototype`) up to the realm's Object.prototype, so only such an object can be linked
 * as [[Construct]]'s prototype, and only its chain is walked by `instanceof`.
 */
export const isOrdinaryObject = (kind: CarrierKind): boolean => MEMBER_ACCESS_ARM[kind] === "object";

/**
 * What the dynamic-value legalization asks of a program's source (`src/ir/source-plain-objects.ts` answers it in one
 * walk): whether it builds ordinary objects, so the object kind is admitted, (F1) whether it creates function values
 * (source closures, which the dispatcher calls), so the function kind is, (O2b) whether it names `Symbol`, the only
 * way to `@@toPrimitive` and `@@toStringTag`, and (G1, W2) the realm constructors it names, by catalog id (built-in
 * function values, which make objects).
 */
export interface ProgramObjects {
  readonly present: boolean;
  readonly functions: boolean;
  readonly namesSymbol: boolean;
  readonly constructors: ReadonlySet<string>;
}

/** (#7354 O2, O4) What the legalization of every function of one program asks of the whole program. */
export interface LegalizationProgram {
  /** What the program's source allows its objects (`source-plain-objects.ts`). */
  readonly objects: ProgramObjects;
  /** Whether the program reads a catch binding (not only rethrows it): a value thrown here is read back as dynamic. */
  readonly catches: boolean;
}

/** A program that builds no ordinary object. */
export const NO_OBJECTS: ProgramObjects = Object.freeze({
  present: false,
  functions: false,
  namesSymbol: false,
  constructors: new Set<string>(),
});

/**
 * (#7354 G1) Whether a value of the program may be an error (`realm-family-bodies.ts`): it names an Error constructor
 * or reads a catch binding, the one way a realm error becomes a value. The realm then holds the Error family
 * (`native-realm-requirements.ts`), whose prototypes the program can read and write.
 */
const holdsErrors = (program: LegalizationProgram): boolean =>
  program.catches || [...program.objects.constructors].some((id) => errorConstructorSelector(id) >= 0);

/**
 * (#7354 G1, W2) The realm families a program's values may come from, derived once per function's legalization from
 * its `LegalizationProgram` (`programFamilies`) and read by every arm through `ChainBuilders.families`.
 */
export interface ProgramFamilies {
  /** (G1) A value may be an error: the program holds the Error family (`holdsErrors`). */
  readonly errors: boolean;
  /**
   * (W2) The wrapper families a value may belong to: those the program names, and all three where it names `Object`
   * (`Object(v)` wraps any primitive). The realm then holds them (`native-realm-requirements.ts` reads the IR's uses).
   */
  readonly wrappers: ReadonlySet<string>;
  /**
   * (W2) The program can obtain a built-in prototype (`Object.prototype`, a wrapper's): it names `Object` or a wrapper
   * constructor, so it can change one; a primitive's member access then reads through the realm's prototype objects.
   */
  readonly prototypes: boolean;
  /** (A1) A value may be an array: the program names `Array` or writes an array literal. */
  readonly arrays: boolean;
}

export function programFamilies(program: LegalizationProgram): ProgramFamilies {
  const named = program.objects.constructors;
  const wrappers = new Set(WRAPPER_IDS.filter((id) => named.has(id) || named.has("%Object%")));
  return {
    errors: holdsErrors(program),
    wrappers,
    prototypes: named.has("%Object%") || wrappers.size > 0,
    arrays: named.has(ARRAY_ID),
  };
}

/** (#7354 W2, A1) The families (constructor ids) whose objects a value may be: the wrappers', and Array's. */
export const objectFamilies = (families: ProgramFamilies): ReadonlySet<string> =>
  families.arrays ? new Set([...families.wrappers, ARRAY_ID]) : families.wrappers;

/**
 * The kinds a value of a program may be: the object kind only where the program builds objects or (#7354 G1) may hold
 * an error, which is an ordinary object, and (F1) the function kind only where it creates function values or (G1) may
 * hold a built-in one (an Error constructor, an error's methods).
 */
export function admittedKinds(program: LegalizationProgram): readonly CarrierKind[] {
  return KIND_ORDER.filter(
    (kind) =>
      (kind !== "object" || program.objects.present || holdsErrors(program)) &&
      (kind !== "function" ||
        program.objects.functions ||
        holdsErrors(program) ||
        program.objects.constructors.size > 0),
  );
}

/**
 * (#7354 M1, C2) The one answer to "which kind does the carrier hold `value` as". Without `boxTag`, `value` is in
 * carrier form (the coercion and throw rules); with it, `value` is the operand of a box to the dynamic value with that
 * tag refinement (the box arm, and the kind a box proves to the chains). The rules, in order: a Boolean (its tag or
 * `js.boolean.box`), `null` (its tag or the null constant, the carrier's null reference), the dynamic value itself, a
 * native string (its own payload), a number (an f64 or `js.number.box`), (#7354 O2, A1) the ordinary object or array
 * `js.object.create-default` / `create-array` answered (whatever its tag: a function-local object's member access boxes
 * the externref it holds without one) or an array literal's helper call (before the dynamic value it is), (#7354 Fa) a function value (a packed callable, or (F1b) the dynamic value under the Function
 * tag a declaration's home holds), or, through a coercion or the function-value projection, its operand's kind. Any
 * other value has none.
 */
export function carrierKindOf(
  value: IrValueId,
  types: ReadonlyMap<IrValueId, IrType>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  boxTag?: TagId,
): "dynamic" | CarrierKind | undefined {
  const type = types.get(value);
  const definition = definitions.get(value);
  const produced = (id: IntrinsicId) => definition?.kind === "intrinsic" && definition.id === id;
  if (boxTag === JS_TAG_IDS.Boolean || produced("js.boolean.box")) return "boolean";
  if (boxTag === JS_TAG_IDS.Null || (definition?.kind === "const" && definition.value.kind === "null")) return "null";
  if (isArrayLiteralCall(definition)) return "object";
  if (type?.kind === "dynamic") return type.tag === JS_TAG_IDS.Function ? "function" : "dynamic";
  if (type?.kind === "string") return type.kind;
  if (type?.kind === "callable") return "function";
  if ((type?.kind === "val" && type.val.kind === "f64") || produced("js.number.box")) return "number";
  const created = definition?.kind === "call" ? irOrdinaryObjectCallableDeclaration(definition.target)?.feature : "";
  if (created === "js.object.create-default" || created === "js.object.create-array") return "object";
  const projected = functionValueOperand(definition);
  if (projected !== undefined) return carrierKindOf(projected, types, definitions);
  return definition?.kind === "coerce.to_externref" ? carrierKindOf(definition.value, types, definitions) : undefined;
}
