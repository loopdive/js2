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
 * (#7339) Beside the statics, the table holds `Object.prototype`'s two
 * own-property tests, spelled `R.<name>(k)` on any receiver: the receiver and
 * the key cross as carriers, and the test answers through `dyn.own_property`
 * (`emitOwnPropertyTest`). Its answer takes the representation main gave the
 * same call: the i32 boolean on a #7280 dynamic home `var o = {}`, which
 * #7335's arm answered so, and on every other receiver that boolean boxed onto
 * the carrier, as main's dynamic method call answered. A test the table does
 * not answer is no table call: the receiver's own arms decide it, as on main.
 *
 * The same rows serve propertyHelper's stored aliases
 * (`uncurried-object-alias.ts`) and #7128 / #7335's define on an open carrier.
 *
 * Lane: non-fast host-free standalone only (`native-object-statics`). A result
 * is read back through the carrier's member read, which answers for an open
 * `$Object` on standalone, not on WASI. A JS environment keeps its own arms
 * (`object-create-call.ts` is the one that reaches this runtime there). The
 * tests also need the `dyn.own_property` provider (`native-own-property-test`),
 * which the JS environment's native regime and WASI build too; the table's
 * lane keeps them to standalone, where #7335's arm ran (on WASI and in a JS
 * environment no script `var o = {}` is an open `$Object`).
 */

import { isUnshadowedUndefined } from "../shared/ambient-intrinsics.js";
import {
  sourceMayPatchPrototype,
  sourceMayWriteUnspelledMember,
  sourceNamesReflectiveRoute,
  sourceWritesMemberNamed,
} from "../shared/intrinsic-prototype-writes.js";
import { ts } from "../ts-api.js";
import type { IrBackendTargetCapability } from "./backend/legality.js";
import type { OwnPropertyTest } from "./nodes.js";
import {
  definesLiteralsOnly,
  descriptorMapDefinitions,
  isPrimitiveLiteral,
  keyedDescriptorDefinition,
  type DescriptorDefinition,
} from "./descriptor-literal.js";
import { unitInKeysAreOwnOnly } from "./empty-object-literal.js";
import { objectStaticsArePristine, ownPropertyTestFacts, type IrObjectIntegrityRealm } from "./object-integrity.js";

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
   * `%Object.prototype%` terminal, and no carrier is known to be non-null
   * ({@link isAdmittedPrototype}).
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

function isObjectStaticName(name: string): name is ObjectStaticName {
  return Object.hasOwn(OBJECT_STATICS, name);
}

const OWN_PROPERTY_TESTS: ReadonlySet<string> = new Set<OwnPropertyTest>(["hasOwnProperty", "propertyIsEnumerable"]);

function isOwnPropertyTest(name: string): name is OwnPropertyTest {
  return OWN_PROPERTY_TESTS.has(name);
}

/** `name` names a row: `Object.<name>(…)`, or a test's `R.<name>(k)`. */
export function isTableCallName(name: string): boolean {
  return isObjectStaticName(name) || isOwnPropertyTest(name);
}

/** The row a stored alias of `name` lowers as: its helper and its arity. */
export function storedObjectStaticRow(name: "getOwnPropertyDescriptor" | "getOwnPropertyNames") {
  const { values, provider } = OBJECT_STATICS[name];
  return { arity: values, provider };
}

/**
 * A test's receiver and key, and the lane of its `dyn.own_property` provider;
 * the uncurried alias `__hasOwnProperty(o, k)` lowers as this row.
 */
export const OWN_PROPERTY_TEST_ROW = { arity: 2, capability: "native-own-property-test" } as const;

export type ObjectStaticCapability = Extract<
  IrBackendTargetCapability,
  "native-object-statics" | typeof OWN_PROPERTY_TEST_ROW.capability
>;

/** The table's lane; a test also needs its provider's. */
const STATICS_LANE: readonly ObjectStaticCapability[] = ["native-object-statics"];
const TEST_LANE: readonly ObjectStaticCapability[] = [...STATICS_LANE, OWN_PROPERTY_TEST_ROW.capability];

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

/**
 * (#7339) An admitted `R.<name>(k)`. `answer` is the representation of its
 * boolean: the i32 (`boolean`) or boxed onto the carrier (`dynamic`).
 */
export interface OwnPropertyTestCall {
  readonly name: OwnPropertyTest;
  readonly receiver: ts.Expression;
  readonly key: ts.Expression;
  readonly answer: "boolean" | "dynamic";
}

/** Every expression an admitted call evaluates, in source order (each crosses as a carrier); undefined for any other plan. */
export function admittedValues(plan: ObjectStaticPlan | undefined): readonly ts.Expression[] | undefined {
  if (plan?.kind === "test") return [plan.test.receiver, plan.test.key];
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
  | { readonly kind: "test"; readonly test: OwnPropertyTestCall }
  | { readonly kind: "refused"; readonly refusal: ObjectStaticRefusal };

/** What the plan asks of the lane and the program, beyond its own source. */
export interface ObjectStaticsRealm extends IrObjectIntegrityRealm {
  readonly supportsBackendCapability: (capability: ObjectStaticCapability) => boolean;
  /** (#7339) `receiver` reads a #7280 dynamic home `var o = {}`, whose test main answered as the i32 boolean. */
  readonly isDynamicHomeReceiver: (receiver: ts.Expression) => boolean;
}

/** An inline `{}`. */
export function isEmptyObjectLiteral(expr: ts.Expression): boolean {
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

/** A prototype operand the create row admits ({@link ObjectStaticRow.prototype}). */
function isAdmittedPrototype(proto: ts.Expression): boolean {
  return isEmptyObjectLiteral(proto) || isPrimitiveLiteral(proto) || isUnshadowedUndefined(proto);
}

/**
 * (#7339) No object in the program can carry an own `method` other than the
 * realm's `Object.prototype` one, so `dyn.own_property` (which ignores an own
 * method) answers as `R.<method>(k)` does: the name is spelled only as a member
 * read's name, never stored, deleted or defined; no member is installed under a
 * name the source does not spell; `Object.prototype` is not patched; there is
 * no reflective route to a prototype; and every `Object.create` makes from a
 * prototype the create row admits, so every object has `%Object.prototype%`
 * on its chain. Dynamic code is the realm's question, asked by the plan.
 */
function ownPropertyTestIsPristine(sourceFile: ts.SourceFile, method: OwnPropertyTest): boolean {
  const { spelled, createPrototypes } = ownPropertyTestFacts(sourceFile, method);
  return (
    !spelled &&
    createPrototypes.every((proto) => proto !== null && isAdmittedPrototype(proto)) &&
    !sourceMayWriteUnspelledMember(sourceFile) &&
    !sourceWritesMemberNamed(sourceFile, method) &&
    !sourceMayPatchPrototype(sourceFile, "Object") &&
    !sourceNamesReflectiveRoute(sourceFile)
  );
}

/**
 * (#7339) The plan of `R.<name>(k)`, a call or nothing: a test the table does
 * not answer (another shape or arity, or a program where an object could carry
 * an own method of its name) is the receiver's own arms' to decide.
 */
function ownPropertyTestPlan(
  call: ts.CallExpression,
  name: OwnPropertyTest,
  realm: ObjectStaticsRealm,
): ObjectStaticPlan | undefined {
  const callee = call.expression as ts.PropertyAccessExpression;
  if (!TEST_LANE.every(realm.supportsBackendCapability)) return undefined;
  if (callee.questionDotToken || call.questionDotToken || call.arguments.length !== 1) return undefined;
  if (ts.isSpreadElement(call.arguments[0]!)) return undefined;
  if (realm.dynamicCodeMayRun || !ownPropertyTestIsPristine(call.getSourceFile(), name)) return undefined;
  const receiver = callee.expression;
  const answer = realm.isDynamicHomeReceiver(receiver) ? "boolean" : "dynamic";
  return { kind: "test", test: { name, receiver, key: call.arguments[0]!, answer } };
}

/**
 * The ONE admission of `Object.<static>(…)` and of the own-property tests
 * ({@link ownPropertyTestPlan}):
 *   - `undefined` when `call` is no table row, or the lane is not the row's:
 *     the other call arms decide;
 *   - `refused` when it is one the IR does not lower. A descriptor that is
 *     not an inline data descriptor is refused: legacy reifies a struct-typed
 *     one before the helper, and the IR has no such step. A call the program
 *     could route elsewhere is refused as `untrusted`: dynamic code may run,
 *     or the source shows a route to `Object` or its statics other than
 *     `Object.<name>` read or called (`objectStaticsArePristine`: a write or
 *     delete of a static, a bare `Object`, `globalThis`, `with`, a reflective
 *     name);
 *   - `call` or `test` otherwise. Its values are the selector's to admit.
 */
export function objectStaticCallPlan(call: ts.CallExpression, realm: ObjectStaticsRealm): ObjectStaticPlan | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const name = callee.name.text;
  if (isOwnPropertyTest(name)) return ownPropertyTestPlan(call, name, realm);
  const receiver = callee.expression;
  if (!isObjectStaticName(name) || !ts.isIdentifier(receiver) || receiver.text !== "Object") return undefined;
  if (!realm.isAmbientBinding(receiver) || !STATICS_LANE.every(realm.supportsBackendCapability)) return undefined;
  const row: ObjectStaticRow = OBJECT_STATICS[name];
  const refused = (refusal: ObjectStaticRefusal): ObjectStaticPlan => ({ kind: "refused", refusal });
  const args = call.arguments;
  const definingArity = row.defines === "keyed" ? 2 : row.defines === undefined ? 0 : 1;
  const minimum = row.values + (row.defines === "optional-map" ? 0 : definingArity);
  if (callee.questionDotToken || call.questionDotToken || args.some(ts.isSpreadElement)) return refused("shape");
  if (args.length < minimum || args.length > row.values + definingArity) return refused("arity");
  if (realm.dynamicCodeMayRun || !objectStaticsArePristine(call.getSourceFile())) return refused("untrusted");
  if (row.prototype && !isAdmittedPrototype(args[0]!)) return refused("proto");
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
