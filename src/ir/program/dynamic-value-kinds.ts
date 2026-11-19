// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 D1, Ty, Str2, Str2-c, O2, Fa) The kinds of value the Prepared dynamic value admits, and how each operation of
 * the dynamic-value legalization answers each kind. Every table is a `Record` over `CarrierKind`, so a slice that
 * admits a kind must give it a row in each; a `refused` row is an operation the kind has no arm for yet, which the
 * legalization refuses by name.
 *
 * Soundness rests on the admitted set: a value enters the carrier only as one of these kinds (`boxedKind`, and the
 * function-value projection), so a test that rules out every other kind proves the last one (`complement`), and a
 * chain over all kinds may leave the last kind untested (`KIND_ORDER`).
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrType } from "../core/nodes.js";
import type { TagId } from "../core/tag-domain.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";
import { NO_OBJECTS, type ProgramObjects } from "../source-plain-objects.js";

/**
 * `typeof`'s answer for each kind. A `typeof` comparison with a literal no kind answers ("symbol", a typo) is
 * constant false; `typeof null` and an object both answer "object".
 */
export const TYPEOF_NAME = {
  number: "number",
  boolean: "boolean",
  string: "string",
  undefined: "undefined",
  null: "object",
  object: "object",
  function: "function",
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
 * kinds' tests. (#7354 Fa × Ty) A function value's test is `js.value.is_function`, a `ref.test` of the source closures'
 * wrapper root.
 */
export const KIND_TEST: Readonly<Record<CarrierKind, IntrinsicId | "ref.is_null" | "complement" | "refused">> = {
  number: "js.value.is_number",
  boolean: "js.value.is_boolean",
  string: "js.value.is_string",
  undefined: "js.extern.is_undefined",
  null: "ref.is_null",
  object: "complement",
  function: "js.value.is_function",
};

/**
 * How ToString (§7.1.17) answers each kind, in the order a chain tests them: the native string it carries, the number
 * formatter, "true"/"false", the kind's own name, or (O2) a plain object's OrdinaryToPrimitive ("[object Object]",
 * `plainObjectToPrimitive`). The last kind is reached untested because the chain is total over this table. (Fa) A
 * function value's ToPrimitive reads the function's `toString` and `valueOf`, which no arm does yet: its ToString
 * refuses, and so do its `+` and its ToNumber below.
 */
export const TO_STRING_ARM: Readonly<
  Record<CarrierKind, "as-string" | "format" | "boolean" | "name" | "plain-object" | "refused">
> = {
  string: "as-string",
  number: "format",
  boolean: "boolean",
  undefined: "name",
  null: "name",
  object: "plain-object",
  function: "refused",
};
export const KIND_ORDER = Object.keys(TO_STRING_ARM) as readonly CarrierKind[];

/**
 * How `+` (§13.15.3) takes each kind after ToPrimitive: a string makes the addition a concatenation, any other kind is
 * summed through ToNumber. A plain object's ToPrimitive is a string.
 */
export const ADD_ROLE: Readonly<Record<CarrierKind, "concat" | "numeric" | "refused">> = {
  number: "numeric",
  boolean: "numeric",
  string: "concat",
  undefined: "numeric",
  null: "numeric",
  object: "concat",
  function: "refused",
};

/**
 * How ToNumber (§7.1.4) answers each kind: the primitive unboxer (a number its payload, a Boolean 0/1, `undefined`
 * NaN, `null` 0), or NaN for a kind whose ToPrimitive is a non-numeric string while the program's objects are plain
 * (`plainObjectRefusal`): a plain object's "[object Object]", (Fa) a function's `Function.prototype.toString` text.
 */
export const TO_NUMBER_ARM: Readonly<Record<CarrierKind, "unbox" | "nan">> = {
  number: "unbox",
  boolean: "unbox",
  string: "unbox",
  undefined: "unbox",
  null: "unbox",
  object: "nan",
  function: "nan",
};

/**
 * The kinds a program's values may be beyond the primitives, which every program has: its ordinary objects, and
 * whether it creates function values.
 */
export interface ProgramKinds {
  readonly objects: ProgramObjects;
  readonly functions: boolean;
}

/** A program of primitives only. */
export const NO_PROGRAM_KINDS: ProgramKinds = Object.freeze({ objects: NO_OBJECTS, functions: false });

/** The kinds the `plain-object` rows were proved for. */
type PlainObjectKinds = "number" | "boolean" | "string" | "undefined" | "null" | "object" | "function";

/**
 * The plain-object rows' verdict for a program: `undefined` when they may answer, else the named refusal
 * (`source-plain-objects.ts` says why the program's objects are not plain). The OrdinaryToPrimitive shortcut is exact
 * only while no callable can be a property value, so the kind set is pinned here: a slice that admits another kind
 * fails to compile until it decides the same question. (Fa) A function value is no property value by itself: the
 * plainness check refuses every function a program stores in a property and every write of `toString` / `valueOf`,
 * so a function value elsewhere leaves the shortcut exact.
 */
export function plainObjectRefusal(program: ProgramKinds): string | undefined {
  const provedKinds: [Exclude<CarrierKind, PlainObjectKinds>] extends [never] ? true : never = true;
  const reason = program.objects.unplain;
  return provedKinds && reason === undefined ? undefined : `ToPrimitive of an object (${reason})`;
}

/** The kinds a value of a program may be: the object and function kinds only where the program creates them. */
export function admittedKinds(program: ProgramKinds): readonly CarrierKind[] {
  return KIND_ORDER.filter(
    (kind) => (kind !== "object" || program.objects.present) && (kind !== "function" || program.functions),
  );
}

/**
 * The kind a box to the dynamic value admits, from its tag refinement and its operand; `undefined` refuses. An object
 * box is admitted only over the value `js.object.create-default` answered (`definition`).
 */
export function boxedKind(
  tag: TagId | undefined,
  source: IrType | undefined,
  definition: IrInstr | undefined,
): CarrierKind | undefined {
  if (tag === JS_TAG_IDS.Boolean) return "boolean";
  if (tag === JS_TAG_IDS.Null) return "null";
  if (tag === JS_TAG_IDS.Object)
    return definition?.kind === "call" &&
      irOrdinaryObjectCallableDeclaration(definition.target)?.feature === "js.object.create-default"
      ? "object"
      : undefined;
  if (source?.kind === "string") return "string";
  return source?.kind === "val" && source.val.kind === "f64" ? "number" : undefined;
}
