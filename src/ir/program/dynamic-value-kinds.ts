// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 D1, Ty, Str2, Str2-c, O2, O2b) The kinds of value the Prepared dynamic value admits, and how each operation
 * of the dynamic-value legalization answers each kind. Every table is a `Record` over `CarrierKind`, so a slice that
 * admits a kind must give it a row in each.
 *
 * Soundness rests on the admitted set: the box arm admits a value only as one of these kinds (`boxedKind`), so a
 * test that rules out every other kind proves the last one (`complement`), and a chain over all kinds may leave the
 * last kind untested (`KIND_ORDER`).
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrType } from "../core/nodes.js";
import type { TagId } from "../core/tag-domain.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";

/**
 * `typeof`'s answer for each kind. A `typeof` comparison with a literal no kind answers ("function", a typo) is
 * constant false; `typeof null` and an object both answer "object".
 */
export const TYPEOF_NAME = {
  number: "number",
  boolean: "boolean",
  string: "string",
  undefined: "undefined",
  null: "object",
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
 * How the carrier tests for each kind: a runtime predicate, the null test, or (an ordinary object) none of the other
 * kinds' tests.
 */
export const KIND_TEST: Readonly<Record<CarrierKind, IntrinsicId | "ref.is_null" | "complement">> = {
  number: "js.value.is_number",
  boolean: "js.value.is_boolean",
  string: "js.value.is_string",
  undefined: "js.extern.is_undefined",
  null: "ref.is_null",
  object: "complement",
};

/**
 * How ToString (§7.1.17) answers each kind, in the order a chain tests them: the native string it carries, the number
 * formatter, "true"/"false", the kind's own name, or (O2b) an object's OrdinaryToPrimitive
 * (`ordinary-to-primitive.ts`). The last kind is reached untested because the chain is total over this table.
 */
export const TO_STRING_ARM: Readonly<
  Record<CarrierKind, "as-string" | "format" | "boolean" | "name" | "to-primitive">
> = {
  string: "as-string",
  number: "format",
  boolean: "boolean",
  undefined: "name",
  null: "name",
  object: "to-primitive",
};
export const KIND_ORDER = Object.keys(TO_STRING_ARM) as readonly CarrierKind[];

/**
 * How `+` (§13.15.3) takes each kind after ToPrimitive: a string makes the addition a concatenation, any other kind is
 * summed through ToNumber. An object's ToPrimitive is a string or a TypeError (`ordinary-to-primitive.ts`).
 */
export const ADD_ROLE: Readonly<Record<CarrierKind, "concat" | "numeric">> = {
  number: "numeric",
  boolean: "numeric",
  string: "concat",
  undefined: "numeric",
  null: "numeric",
  object: "concat",
};

/**
 * How ToNumber (§7.1.4) answers each kind: the primitive unboxer (a number its payload, a Boolean 0/1, `undefined`
 * NaN, `null` 0), or (O2b) an object's ToPrimitive, a string that reads as NaN.
 */
export const TO_NUMBER_ARM: Readonly<Record<CarrierKind, "unbox" | "to-primitive">> = {
  number: "unbox",
  boolean: "unbox",
  string: "unbox",
  undefined: "unbox",
  null: "unbox",
  object: "to-primitive",
};

/**
 * (#7354 O4, O3) How a member read (GetValue) and a member write (PutValue) take each receiver
 * kind: both ToObject the base, so `undefined` and `null` throw a TypeError; an object is the realm's [[Get]] or
 * [[Set]]; a primitive reaches only built-in prototypes (`builtin-prototype-keys.ts`), and (O2b) only while no code
 * can reach them to change them.
 */
export const MEMBER_ACCESS_ARM: Readonly<Record<CarrierKind, "type-error" | "object" | "primitive">> = {
  number: "primitive",
  boolean: "primitive",
  string: "primitive",
  undefined: "type-error",
  null: "type-error",
  object: "object",
};

/**
 * What the dynamic-value legalization asks of a program's source (`src/ir/source-plain-objects.ts` answers it in one
 * walk): whether it builds ordinary objects, so the object kind is admitted; (O2b) whether it names `Symbol`, the only
 * way to `@@toPrimitive`; and (O4) `unplain`, the first way its code can reach a built-in prototype to change it,
 * which a member read of a primitive must exclude.
 */
export interface ProgramObjects {
  readonly present: boolean;
  readonly namesSymbol: boolean;
  readonly unplain: string | undefined;
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
  namesSymbol: false,
  unplain: undefined,
});

/** The kinds a value of a program may be: the object kind only where the program builds objects. */
export function admittedKinds(objects: ProgramObjects): readonly CarrierKind[] {
  return objects.present ? KIND_ORDER : KIND_ORDER.filter((kind) => kind !== "object");
}

/**
 * The kind a box to the dynamic value admits, from its tag refinement and its operand; `undefined` refuses. An object
 * box is admitted only over the value `js.object.create-default` answered (`definition`), (#7354 O3) whatever its tag:
 * a function-local object's member access boxes the externref it holds without one.
 */
export function boxedKind(
  tag: TagId | undefined,
  source: IrType | undefined,
  definition: IrInstr | undefined,
): CarrierKind | undefined {
  if (
    definition?.kind === "call" &&
    irOrdinaryObjectCallableDeclaration(definition.target)?.feature === "js.object.create-default"
  )
    return "object";
  if (tag === JS_TAG_IDS.Boolean) return "boolean";
  if (tag === JS_TAG_IDS.Null) return "null";
  if (source?.kind === "string") return "string";
  return source?.kind === "val" && source.val.kind === "f64" ? "number" : undefined;
}
