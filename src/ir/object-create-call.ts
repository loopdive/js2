// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7276) `Object.create({}, { <key>: { <data fields> }, … })` as one IR
 * lowering, admitted by ONE plan that the selector and from-ast both read.
 *
 * Legacy expands the descriptor map at compile time (`call-builtin-static.ts`,
 * the `Object.create` arm): `__object_create(<proto $Object>)`, then one
 * define per key. For the literal descriptors admitted here, legacy folds the
 * flags (`__defineProperty_value(obj, key, value, flags)`). The IR instead
 * takes legacy's other arm, the one for descriptors it cannot fold: the #7128
 * open-carrier define, `__obj_define_from_desc` over a descriptor `$Object`.
 * That runs ToPropertyDescriptor at runtime over the same literal fields, so
 * no flag encoding is duplicated. The object crosses onto the dynamic
 * carrier, whose member-read / `typeof` / `for-in` / `in` arms serve the
 * result — with one exception, below.
 *
 * Lanes: `native-dynamic-member-read`, i.e. standalone and the native-first
 * gc lane, which projects as standalone (`legality.ts`). WASI keeps legacy:
 * its IR member read does not answer for an open `$Object`.
 *
 * Admitted, so that the definition order and every descriptor are fixed at
 * compile time:
 *   - the proto is the empty literal `{}`. `null` is refused, because
 *     `__object_create` reads a null proto as the `%Object.prototype%`
 *     terminal (`compileProtoArg`) and the IR has its own
 *     `Object.create(null)` contract. Any other proto is refused too;
 *   - the map is an object literal of distinct identifier / string-literal
 *     keys. A canonical array-index key is refused because §20.1.2.3.1
 *     ObjectDefineProperties defines in [[OwnPropertyKeys]] order (indices
 *     first) where legacy defines in source order. `__proto__` is refused
 *     because it sets the map's prototype and defines no key;
 *   - each value is a literal data descriptor
 *     ({@link literalDataDescriptorFields}). An accessor, a computed flag or
 *     a non-literal descriptor keeps legacy;
 *   - every `in` of the enclosing unit has a string-literal key that
 *     `%Object.prototype%` does not own ({@link unitInKeysAreOwnOnly}). The
 *     IR's native `in` (`__extern_has`) does not reach an open `$Object`'s
 *     implicit `%Object.prototype%` terminal, while legacy's fixed-name helper
 *     answers it for exactly the receivers it knows to be one. Its constant
 *     fallback is wrong for every other carrier, so neither `in` can stand in
 *     for the other (#7142 review). Such a unit keeps legacy as before.
 */

import ts from "typescript";

import { isUnshadowedLibBinding } from "../shared/ambient-intrinsics.js";
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import {
  literalDataDescriptorFields,
  staticNamedProperties,
  type DataDescriptorField,
} from "./empty-object-literal.js";
import { irDynamic, irVal, type IrValueId } from "./nodes.js";
import { emitNewPlainObject, emitOpenCarrierDefine } from "./open-object-carrier.js";

/** The one key the descriptor map defines, with its descriptor's fields. */
interface ObjectCreateProperty {
  readonly key: string;
  readonly fields: readonly DataDescriptorField[];
}

/** What both sides ask of their lane and binding resolver. */
export interface IrObjectCreateAdmission {
  /** The result is read through the carrier's member read (standalone only; see `legality.ts`). */
  readonly supportsBackendCapability: (capability: "native-dynamic-member-read") => boolean;
  /** The lib-only binding test — a script `function Object() {}` merges with the lib's. */
  readonly isLibOnlyBinding: (node: ts.Identifier) => boolean;
}

const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/** The descriptor map's keys in source order, or null when one is not admitted. */
function descriptorMapProperties(map: ts.Expression): readonly ObjectCreateProperty[] | null {
  const entries = staticNamedProperties(map);
  if (entries === null) return null;
  const properties: ObjectCreateProperty[] = [];
  for (const { name: key, initializer } of entries) {
    if (key === "__proto__" || CANONICAL_ARRAY_INDEX.test(key)) return null;
    const fields = literalDataDescriptorFields(initializer);
    if (fields === null) return null;
    properties.push({ key, fields });
  }
  return properties;
}

/** The admitted call's descriptor map, else null. Read by the selector and by from-ast. */
export function objectCreateDescriptorMap(
  expr: ts.CallExpression,
  admission: IrObjectCreateAdmission,
): readonly ObjectCreateProperty[] | null {
  const callee = expr.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    callee.name.text !== "create" ||
    callee.questionDotToken ||
    expr.questionDotToken ||
    expr.typeArguments?.length ||
    expr.arguments.length !== 2
  ) {
    return null;
  }
  const proto = expr.arguments[0]!;
  if (!ts.isObjectLiteralExpression(proto) || proto.properties.length > 0) return null;
  if (!admission.supportsBackendCapability("native-dynamic-member-read")) return null;
  const properties = descriptorMapProperties(expr.arguments[1]!);
  if (properties === null || !isUnshadowedLibBinding(callee.expression, admission.isLibOnlyBinding)) return null;
  return unitInKeysAreOwnOnly(expr) ? properties : null;
}

const inKeysByUnit = new WeakMap<ts.Node, boolean>();

/**
 * Every `in` under the enclosing unit of `expr` (its function, or the source
 * file for `<module-init>`), nested functions included, has a string-literal
 * key that `%Object.prototype%` does not own: an own-key probe, which the
 * native `in` answers for an open `$Object` exactly as legacy does. Shared
 * with the #7280 empty-literal carrier, which builds the same object.
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

/** What the lowering needs from from-ast (no import of the lowerer itself). */
export interface ObjectCreateLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly admission: IrObjectCreateAdmission;
  /** Each field's literal value, boxed onto the dynamic carrier. */
  readonly lowerFields: (
    fields: readonly DataDescriptorField[],
  ) => { readonly name: string; readonly value: IrValueId }[];
}

/**
 * from-ast's half, behind the same plan as the selector. Null when the call is
 * not admitted on this lane, which leaves it to the other call arms. Every
 * operand is a literal, so lowering the fields at their define is the
 * argument evaluation order.
 */
export function lowerObjectCreateDescriptorMapCall(
  expr: ts.CallExpression,
  host: ObjectCreateLoweringHost,
): IrValueId | null {
  const properties = objectCreateDescriptorMap(expr, host.admission);
  if (properties === null) return null;
  const { builder } = host;
  const externref = irVal({ kind: "externref" });
  const proto = emitNewPlainObject(builder, externref);
  const object = builder.emitCall(irRuntimeFuncRef("__object_create"), [proto], externref);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (object === null) throw new Error("ir/object-create-call: __object_create produced no value");
  for (const { key, fields } of properties) emitOpenCarrierDefine(builder, object, key, host.lowerFields(fields));
  return builder.emitBox(object, irDynamic());
}
