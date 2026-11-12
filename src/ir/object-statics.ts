// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7338 — the `Object` statics the IR lowers through the dynamic carrier, as
 * ONE table. A row names the object-runtime helper legacy standalone calls for
 * the static and the role of each operand; `Object.<static>(…)` on the ambient
 * `Object` lowers to every operand as a carrier, then that helper
 * (`emitObjectStaticCall`, `open-object-carrier.ts`). The selector and
 * from-ast both read {@link objectStaticCallPlan}, so they agree on every
 * call, and a call the plan declines is refused at selection.
 *
 * The same rows serve propertyHelper's stored aliases
 * (`uncurried-object-alias.ts`), #7128 / #7335's define on an open carrier and
 * #7276's `Object.create` with a literal descriptor map.
 *
 * Lanes: non-fast host-free standalone only (`native-object-statics`). The
 * helpers are the native object runtime's, and a result is read back through
 * the carrier's member read, which answers for an open `$Object` on
 * standalone, not on WASI. A JS environment keeps its own arms and the one
 * call it lowered before ({@link jsEnvironmentCreate}), so its output does not
 * move.
 */

import { isUnshadowedLibBinding, isUnshadowedUndefined } from "../shared/ambient-intrinsics.js";
import { ts } from "../ts-api.js";
import type { IrBackendTargetCapability } from "./backend/legality.js";
import {
  constantDataDescriptorFields,
  dataDescriptorFields,
  isLiteralDefineShape,
  literalDataDescriptorFields,
  staticNamedProperties,
  type DataDescriptorField,
} from "./empty-object-literal.js";
import { objectStaticsArePristine, type IrObjectIntegrityRealm } from "./object-integrity.js";
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";

/** The object-runtime helpers the rows call: `externref` operands, an `externref` result. */
export type ObjectStaticProvider = "__getOwnPropertyDescriptor" | "__getOwnPropertyNames" | "__object_create";

/**
 * What an operand is to its static:
 *   - `value`: any value, crossed as a carrier;
 *   - `descriptor`: a property descriptor, defined on the first operand under the key before it;
 *   - `descriptor-map`: a map of keys to descriptors, each defined on the first operand.
 */
type OperandRole = "value" | "descriptor" | "descriptor-map";

interface ObjectStaticRow {
  readonly operands: readonly OperandRole[];
  /** How many leading operands a call must pass; the rest are optional. */
  readonly required: number;
  /** The helper over the `value` operands, whose result the static answers; absent when it only defines on, and answers, its first operand. */
  readonly provider?: ObjectStaticProvider;
  /**
   * What the static demands of its first operand, a TypeError otherwise:
   * `object` (§20.1.2.2–4 step 1) or `coercible` (ToObject: not `undefined`
   * or `null`, §20.1.2.8 / .10). No helper checks: legacy throws at compile
   * time for an operand the checker types so, the IR tests the carrier.
   */
  readonly first: "object" | "coercible";
  /**
   * The first operand is a prototype: an inline `{}`, or a primitive literal
   * or `undefined` (a TypeError). `__object_create` reads a null proto as the
   * `%Object.prototype%` terminal, and no carrier is known to be non-null;
   * `Object.create(null)` is the IR's separate contract.
   */
  readonly literalProto?: true;
  /** The result is a fresh open `$Object`, as it is for any static whose first operand is an inline `{}`. */
  readonly fresh?: true;
}

const OBJECT_STATICS = {
  defineProperty: { operands: ["value", "value", "descriptor"], required: 3, first: "object" },
  defineProperties: { operands: ["value", "descriptor-map"], required: 2, first: "object" },
  getOwnPropertyDescriptor: {
    operands: ["value", "value"],
    required: 2,
    provider: "__getOwnPropertyDescriptor",
    first: "coercible",
  },
  getOwnPropertyNames: { operands: ["value"], required: 1, provider: "__getOwnPropertyNames", first: "coercible" },
  create: {
    operands: ["value", "descriptor-map"],
    required: 1,
    provider: "__object_create",
    first: "object",
    literalProto: true,
    fresh: true,
  },
} as const satisfies Record<string, ObjectStaticRow>;

export type ObjectStaticName = keyof typeof OBJECT_STATICS;

/** The helper of a static that has one: what a stored alias of it calls. */
export function objectStaticProvider<Name extends "getOwnPropertyDescriptor" | "getOwnPropertyNames">(
  name: Name,
): (typeof OBJECT_STATICS)[Name]["provider"] {
  return OBJECT_STATICS[name].provider;
}

/** How many operands a stored alias of `name` takes. */
export function objectStaticArity(name: ObjectStaticName): number {
  return OBJECT_STATICS[name].required;
}

/**
 * `native-object-statics`: the lane the table lowers on, host-free standalone.
 * `native-dynamic-member-read`: the regime {@link jsEnvironmentCreate} needs.
 */
export type ObjectStaticCapability = Extract<
  IrBackendTargetCapability,
  "native-object-statics" | "native-dynamic-member-read"
>;

/** One key a descriptor operand defines, with its data descriptor's fields in source order. */
export interface ObjectStaticDefinition {
  /** The key's own operand, or (a descriptor map's) its static name. */
  readonly key: ts.Expression | string;
  readonly fields: readonly DataDescriptorField[];
}

export type ObjectStaticOperand =
  | { readonly kind: "value"; readonly expr: ts.Expression }
  /** An inline `{}`: a fresh open `$Object`. */
  | { readonly kind: "object" };

/** An admitted call: its value operands in order, then the definitions it applies to the first. */
export interface ObjectStaticCall {
  readonly name: ObjectStaticName;
  readonly provider: ObjectStaticProvider | undefined;
  readonly first: "object" | "coercible";
  /** #7128's U1 shape: `defineProperty` with a literal key and a descriptor of primitive literals. */
  readonly literalDefine: boolean;
  /** {@link jsEnvironmentCreate}'s call, not the table lane's. */
  readonly jsEnvironment: boolean;
  readonly operands: readonly ObjectStaticOperand[];
  readonly definitions: readonly ObjectStaticDefinition[];
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

/**
 * {@link admittedValues} of a call on the table's own lane: what the move-only
 * scan crosses as carriers and the call-graph walk visits. The JS
 * environment's one call ({@link jsEnvironmentCreate}) never reached either.
 */
export function scannedValues(plan: ObjectStaticPlan | undefined): readonly ts.Expression[] | undefined {
  return plan?.kind === "call" && !plan.call.jsEnvironment ? admittedValues(plan) : undefined;
}

/** #7128's U1 define: an admitted `Object.defineProperty` whose key and descriptor are literals. */
export function isLiteralDefine(plan: ObjectStaticPlan | undefined): boolean {
  return plan?.kind === "call" && plan.call.literalDefine;
}

/** Why a call of a table static keeps legacy; the selector reports it as `expr-object-static-<refusal>`. */
export type ObjectStaticRefusal = "shape" | "arity" | "untrusted" | "proto" | "descriptor" | "in-key";

export type ObjectStaticPlan =
  | { readonly kind: "call"; readonly call: ObjectStaticCall }
  | { readonly kind: "refused"; readonly refusal: ObjectStaticRefusal };

/** What the plan asks of the lane and the program, beyond its own source. */
export interface ObjectStaticsRealm extends IrObjectIntegrityRealm {
  readonly supportsBackendCapability: (capability: ObjectStaticCapability) => boolean;
  /** The lib-only binding test of {@link jsEnvironmentCreate}: a script `function Object() {}` merges with the lib's. */
  readonly isLibOnlyBinding: (node: ts.Identifier) => boolean;
}

const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * A literal descriptor map's definitions in source order, else null. A
 * canonical array-index key is refused because §20.1.2.3.1 defines in
 * [[OwnPropertyKeys]] order (indices first), and `__proto__` because it sets
 * the map's prototype and defines no key. Each descriptor is one `fieldsOf`
 * reads: its values are constants, so that lowering each at its define (the
 * order #7276 fixed) is the map's evaluation order.
 */
function descriptorMapDefinitions(
  map: ts.Expression,
  fieldsOf: (descriptor: ts.Expression) => readonly DataDescriptorField[] | null,
): readonly ObjectStaticDefinition[] | null {
  const entries = staticNamedProperties(map);
  if (entries === null) return null;
  const definitions: ObjectStaticDefinition[] = [];
  for (const { name: key, initializer } of entries) {
    const fields = key === "__proto__" || CANONICAL_ARRAY_INDEX.test(key) ? null : fieldsOf(initializer);
    if (fields === null) return null;
    definitions.push({ key, fields });
  }
  return definitions;
}

/** A boolean, number or string literal, or the global `undefined`: never an Object, never null. */
function isPrimitiveOrUndefined(expr: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteralLike(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    isUnshadowedUndefined(expr)
  );
}

function isEmptyObjectLiteral(expr: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(expr) && expr.properties.length === 0;
}

/**
 * The ONE admission of `Object.<static>(…)`:
 *   - `undefined` when `call` is no table static on the ambient `Object`:
 *     the other call arms decide. Off the table's lane only
 *     {@link jsEnvironmentCreate}'s call is one;
 *   - `refused` when it is one the IR does not lower. A descriptor that is
 *     not an inline data descriptor is refused: legacy reifies a struct-typed
 *     one before the helper, and the IR has no such step. A call the program could
 *     route elsewhere is refused as `untrusted`: dynamic code may run, or the
 *     source shows a route to `Object` or its statics other than
 *     `Object.<name>` read or called (`objectStaticsArePristine`: a write or
 *     delete of a static, a bare `Object`, `globalThis`, `with`, a reflective
 *     name);
 *   - `call` otherwise. Its operand values are the selector's to admit.
 */
export function objectStaticCallPlan(call: ts.CallExpression, realm: ObjectStaticsRealm): ObjectStaticPlan | undefined {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    !Object.hasOwn(OBJECT_STATICS, callee.name.text)
  ) {
    return undefined;
  }
  const name = callee.name.text as ObjectStaticName;
  if (!realm.supportsBackendCapability("native-object-statics")) return jsEnvironmentCreate(call, name, realm);
  if (!realm.isAmbientBinding(callee.expression)) return undefined;
  const refused = (refusal: ObjectStaticRefusal): ObjectStaticPlan => ({ kind: "refused", refusal });
  const row: ObjectStaticRow = OBJECT_STATICS[name];
  const args = call.arguments;
  if (callee.questionDotToken || call.questionDotToken || args.some(ts.isSpreadElement)) return refused("shape");
  if (args.length < row.required || args.length > row.operands.length) return refused("arity");
  if (realm.dynamicCodeMayRun || !objectStaticsArePristine(call.getSourceFile())) return refused("untrusted");
  if (row.literalProto && !isEmptyObjectLiteral(args[0]!) && !isPrimitiveOrUndefined(args[0]!)) return refused("proto");

  const operands: ObjectStaticOperand[] = [];
  let definitions: readonly ObjectStaticDefinition[] = [];
  for (const [index, arg] of args.entries()) {
    const role = row.operands[index]!;
    if (role === "value") {
      operands.push(isEmptyObjectLiteral(arg) ? { kind: "object" } : { kind: "value", expr: arg });
      continue;
    }
    let defined: readonly ObjectStaticDefinition[] | null;
    if (role === "descriptor") {
      // The key is defined under, not passed to the helper.
      operands.pop();
      const fields = dataDescriptorFields(arg);
      defined = fields && [{ key: args[index - 1]!, fields }];
    } else {
      defined = descriptorMapDefinitions(arg, constantDataDescriptorFields);
    }
    if (defined === null) return refused("descriptor");
    definitions = defined;
  }
  // The native `in` reads only the own keys of a fresh open `$Object`.
  if ((row.fresh || operands[0]?.kind === "object") && !unitInKeysAreOwnOnly(call)) return refused("in-key");
  return admitted(call, name, operands, definitions);
}

function admitted(
  call: ts.CallExpression,
  name: ObjectStaticName,
  operands: readonly ObjectStaticOperand[],
  definitions: readonly ObjectStaticDefinition[],
  jsEnvironment = false,
): ObjectStaticPlan {
  const { provider, first }: ObjectStaticRow = OBJECT_STATICS[name];
  const literalDefine = name === "defineProperty" && isLiteralDefineShape(call);
  return { kind: "call", call: { name, provider, first, literalDefine, jsEnvironment, operands, definitions } };
}

/**
 * (#7276) The one call a JS environment under the native regime lowers through
 * the table, until its own A/B: `Object.create({}, { <literal data
 * descriptors> })`, admitted exactly as it was there so that its bytes do not
 * move. Any other call is undefined: the environment's own arms decide.
 */
function jsEnvironmentCreate(
  call: ts.CallExpression,
  name: ObjectStaticName,
  realm: ObjectStaticsRealm,
): ObjectStaticPlan | undefined {
  const callee = call.expression as ts.PropertyAccessExpression;
  const [proto, map] = call.arguments;
  if (
    name !== "create" ||
    callee.questionDotToken ||
    call.questionDotToken ||
    call.typeArguments?.length ||
    call.arguments.length !== 2 ||
    !isEmptyObjectLiteral(proto!) ||
    !realm.supportsBackendCapability("native-dynamic-member-read")
  ) {
    return undefined;
  }
  const definitions = descriptorMapDefinitions(map!, literalDataDescriptorFields);
  const admittedBefore =
    definitions !== null &&
    isUnshadowedLibBinding(callee.expression as ts.Identifier, realm.isLibOnlyBinding) &&
    unitInKeysAreOwnOnly(call);
  return admittedBefore ? admitted(call, name, [{ kind: "object" }], definitions, true) : undefined;
}

const inKeysByUnit = new WeakMap<ts.Node, boolean>();

/**
 * Every `in` under the enclosing unit of `expr` (its function, or the source
 * file for `<module-init>`), nested functions included, has a string-literal
 * key that `%Object.prototype%` does not own: an own-key probe, which the
 * native `in` answers for an open `$Object` exactly as legacy does. The IR's
 * native `in` (`__extern_has`) does not reach an open `$Object`'s implicit
 * `%Object.prototype%` terminal, while legacy's fixed-name helper answers it
 * for exactly the receivers it knows to be one (#7142 review). Shared with the
 * #7280 empty-literal carrier, which builds the same object.
 */
export function unitInKeysAreOwnOnly(expr: ts.Node): boolean {
  let unit: ts.Node = expr.getSourceFile();
  for (let node: ts.Node | undefined = expr.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      unit = node;
      break;
    }
  }
  let answer = inKeysByUnit.get(unit);
  if (answer === undefined) {
    answer = true;
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        !(ts.isStringLiteral(node.left) && !OBJECT_PROTOTYPE_KEYS.has(node.left.text))
      ) {
        answer = false;
      }
      if (answer) ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit, visit);
    inKeysByUnit.set(unit, answer);
  }
  return answer;
}
