// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7338 — the `Object` statics the IR lowers through the dynamic carrier, as
 * ONE table. A row names the object-runtime helper legacy standalone calls for
 * the static and what its arguments are; `Object.<static>(…)` on the ambient
 * `Object` lowers to every value as a carrier, then that helper
 * (`emitObjectStaticCall`, `open-object-carrier.ts`). The selector and
 * from-ast both read {@link objectStaticCallPlan}, so they agree on every
 * call, and a call the plan declines is refused at selection.
 *
 * The same rows serve propertyHelper's stored aliases
 * (`uncurried-object-alias.ts`) and #7128 / #7335's define on an open carrier.
 *
 * Lane: non-fast host-free standalone only (`native-object-statics`). A result
 * is read back through the carrier's member read, which answers for an open
 * `$Object` on standalone, not on WASI. A JS environment keeps its own arms
 * (`object-create-call.ts` is the one that reaches this runtime there).
 */

import { isUnshadowedUndefined } from "../shared/ambient-intrinsics.js";
import { ts } from "../ts-api.js";
import type { IrBackendTargetCapability } from "./backend/legality.js";
import {
  definesLiteralsOnly,
  descriptorMapDefinitions,
  isPrimitiveLiteral,
  keyedDescriptorDefinition,
  type DescriptorDefinition,
} from "./descriptor-literal.js";
import { unitInKeysAreOwnOnly } from "./empty-object-literal.js";
import { objectStaticsArePristine, type IrObjectIntegrityRealm } from "./object-integrity.js";

/** The object-runtime helpers the rows call: `externref` operands, an `externref` result. */
export type ObjectStaticProvider = "__getOwnPropertyDescriptor" | "__getOwnPropertyNames" | "__object_create";

interface ObjectStaticRow {
  /** How many leading arguments are values, each crossed as a carrier. */
  readonly values: number;
  /**
   * What the arguments after the values define on the static's answer: one
   * key and its descriptor (`keyed`), or a descriptor map (`map`, optional
   * when `optional-map`).
   */
  readonly defines?: "keyed" | "map" | "optional-map";
  /** The helper over the values, whose result the static answers; absent when it answers its first value. */
  readonly provider?: ObjectStaticProvider;
  /**
   * The TypeError step 1 throws for a first value that is not an Object
   * (`object`, §20.1.2.2–4) or is `undefined` / `null` (`coercible`,
   * ToObject, §20.1.2.10), on the rows whose helper does not throw it:
   * `__obj_define_from_desc` and `__object_create` take any first value,
   * `__getOwnPropertyNames` answers a nullish one, and a define on an empty
   * map calls no helper at all. `__getOwnPropertyDescriptor` throws itself.
   */
  readonly requires?: "object" | "coercible";
  /**
   * The first value is a prototype and the answer a fresh open `$Object`. The
   * prototype is an inline `{}`, or a primitive literal or `undefined` (step
   * 1's TypeError): `__object_create` reads a null proto as the
   * `%Object.prototype%` terminal, and no carrier is known to be non-null.
   */
  readonly prototype?: true;
}

const OBJECT_STATICS = {
  defineProperty: { values: 1, defines: "keyed", requires: "object" },
  defineProperties: { values: 1, defines: "map", requires: "object" },
  getOwnPropertyDescriptor: { values: 2, provider: "__getOwnPropertyDescriptor" },
  getOwnPropertyNames: { values: 1, provider: "__getOwnPropertyNames", requires: "coercible" },
  create: { values: 1, defines: "optional-map", provider: "__object_create", requires: "object", prototype: true },
} as const satisfies Record<string, ObjectStaticRow>;

export type ObjectStaticName = keyof typeof OBJECT_STATICS;

/** The row a stored alias of `name` lowers as: its helper and its arity. */
export function storedObjectStaticRow(name: "getOwnPropertyDescriptor" | "getOwnPropertyNames") {
  const { values, provider } = OBJECT_STATICS[name];
  return { arity: values, provider };
}

export type ObjectStaticCapability = Extract<IrBackendTargetCapability, "native-object-statics">;

export type ObjectStaticOperand =
  | { readonly kind: "value"; readonly expr: ts.Expression }
  /** An inline `{}`: a fresh open `$Object`. */
  | { readonly kind: "object" };

/** An admitted call: its values in order, then the definitions it applies to its answer. */
export interface ObjectStaticCall {
  readonly name: ObjectStaticName;
  readonly provider: ObjectStaticProvider | undefined;
  readonly requires: "object" | "coercible" | undefined;
  readonly operands: readonly ObjectStaticOperand[];
  readonly definitions: readonly DescriptorDefinition[];
}

/** Every expression an admitted call evaluates, in source order (each crosses as a carrier); undefined for any other plan. */
export function admittedValues(plan: ObjectStaticPlan | undefined): readonly ts.Expression[] | undefined {
  if (plan?.kind !== "call") return undefined;
  const { operands, definitions } = plan.call;
  return [
    ...operands.flatMap((operand) => (operand.kind === "value" ? [operand.expr] : [])),
    ...definitions.flatMap(({ key, fields }) => [
      ...(typeof key === "string" ? [] : [key]),
      ...fields.map((field) => field.initializer),
    ]),
  ];
}

/** #7128's U1 define: an admitted call that only defines, literal keys and literal descriptors. */
export function isLiteralDefine(plan: ObjectStaticPlan | undefined): boolean {
  return plan?.kind === "call" && plan.call.provider === undefined && definesLiteralsOnly(plan.call.definitions);
}

/** Why a call of a table static keeps legacy; the selector reports it as `expr-object-static-<refusal>`. */
export type ObjectStaticRefusal = "shape" | "arity" | "untrusted" | "proto" | "descriptor" | "in-key";

export type ObjectStaticPlan =
  | { readonly kind: "call"; readonly call: ObjectStaticCall }
  | { readonly kind: "refused"; readonly refusal: ObjectStaticRefusal };

/** What the plan asks of the lane and the program, beyond its own source. */
export interface ObjectStaticsRealm extends IrObjectIntegrityRealm {
  readonly supportsBackendCapability: (capability: ObjectStaticCapability) => boolean;
}

function isEmptyObjectLiteral(expr: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(expr) && expr.properties.length === 0;
}

/** The definitions the arguments after a row's values make, else null. */
function rowDefinitions(
  row: ObjectStaticRow,
  defining: readonly ts.Expression[],
): readonly DescriptorDefinition[] | null {
  if (defining.length === 0) return [];
  if (row.defines !== "keyed") return descriptorMapDefinitions(defining[0]!, () => true);
  const definition = keyedDescriptorDefinition(defining[0]!, defining[1]!);
  return definition && [definition];
}

/**
 * The ONE admission of `Object.<static>(…)`:
 *   - `undefined` when `call` is no table static on the ambient `Object`, or
 *     the lane is not the table's: the other call arms decide;
 *   - `refused` when it is one the IR does not lower. A descriptor that is
 *     not an inline data descriptor is refused: legacy reifies a struct-typed
 *     one before the helper, and the IR has no such step. A call the program
 *     could route elsewhere is refused as `untrusted`: dynamic code may run,
 *     or the source shows a route to `Object` or its statics other than
 *     `Object.<name>` read or called (`objectStaticsArePristine`: a write or
 *     delete of a static, a bare `Object`, `globalThis`, `with`, a reflective
 *     name);
 *   - `call` otherwise. Its values are the selector's to admit.
 */
export function objectStaticCallPlan(call: ts.CallExpression, realm: ObjectStaticsRealm): ObjectStaticPlan | undefined {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    !Object.hasOwn(OBJECT_STATICS, callee.name.text) ||
    !realm.supportsBackendCapability("native-object-statics") ||
    !realm.isAmbientBinding(callee.expression)
  ) {
    return undefined;
  }
  const name = callee.name.text as ObjectStaticName;
  const refused = (refusal: ObjectStaticRefusal): ObjectStaticPlan => ({ kind: "refused", refusal });
  const row: ObjectStaticRow = OBJECT_STATICS[name];
  const args = call.arguments;
  const definingArity = row.defines === "keyed" ? 2 : row.defines === undefined ? 0 : 1;
  const minimum = row.values + (row.defines === "optional-map" ? 0 : definingArity);
  if (callee.questionDotToken || call.questionDotToken || args.some(ts.isSpreadElement)) return refused("shape");
  if (args.length < minimum || args.length > row.values + definingArity) return refused("arity");
  if (realm.dynamicCodeMayRun || !objectStaticsArePristine(call.getSourceFile())) return refused("untrusted");
  const first = args[0]!;
  if (row.prototype && !isEmptyObjectLiteral(first) && !isPrimitiveLiteral(first) && !isUnshadowedUndefined(first)) {
    return refused("proto");
  }
  const definitions = rowDefinitions(row, args.slice(row.values));
  if (definitions === null) return refused("descriptor");
  const operands = args
    .slice(0, row.values)
    .map((arg): ObjectStaticOperand => (isEmptyObjectLiteral(arg) ? { kind: "object" } : { kind: "value", expr: arg }));
  // The native `in` reads only the own keys of a fresh open `$Object`.
  if ((row.prototype || operands[0]!.kind === "object") && !unitInKeysAreOwnOnly(call)) return refused("in-key");
  // A fresh `{}` is an Object by construction.
  const requires = operands[0]!.kind === "object" ? undefined : row.requires;
  return { kind: "call", call: { name, provider: row.provider, requires, operands, definitions } };
}
