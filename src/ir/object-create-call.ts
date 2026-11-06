// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7276) `Object.create({}, { <key>: { <data fields> }, … })` as one IR
 * lowering, admitted by ONE plan that the selector and from-ast both read.
 *
 * Legacy expands the descriptor map at compile time (`call-builtin-static.ts`,
 * the `Object.create` arm): `__object_create(<proto $Object>)`, then one
 * per-key define. The IR emits the same sequence from the same runtime
 * family. The proto is a fresh open `$Object`, and each key goes through the
 * #7128 open-carrier define (`__obj_define_from_desc` over a descriptor
 * `$Object`, the applier legacy's standalone arm calls for a descriptor it
 * cannot fold). The object crosses onto the dynamic carrier, whose existing
 * member-read / `typeof` / `for-in` machinery serves the result.
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
 *     a non-literal descriptor keeps legacy.
 */

import ts from "typescript";

import { isUnshadowedLibGlobal } from "../shared/ambient-intrinsics.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { literalDataDescriptorFields, type DataDescriptorField } from "./empty-object-literal.js";
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
  readonly supportsBackendCapability: ((capability: "native-dynamic-member-read") => boolean) | undefined;
  /** The lib-only binding test — a script `function Object() {}` merges with the lib's. */
  readonly isLibOnlyBinding: (node: ts.Identifier) => boolean;
}

const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/** The descriptor map's keys in source order, or null when one is not admitted. */
function descriptorMapProperties(map: ts.Expression): readonly ObjectCreateProperty[] | null {
  if (!ts.isObjectLiteralExpression(map)) return null;
  const properties: ObjectCreateProperty[] = [];
  for (const property of map.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      return null;
    }
    const key = property.name.text;
    if (key === "__proto__" || CANONICAL_ARRAY_INDEX.test(key) || properties.some((p) => p.key === key)) return null;
    const fields = literalDataDescriptorFields(property.initializer);
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
  const [proto, map] = expr.arguments as unknown as [ts.Expression, ts.Expression];
  if (!ts.isObjectLiteralExpression(proto) || proto.properties.length > 0) return null;
  if (admission.supportsBackendCapability?.("native-dynamic-member-read") !== true) return null;
  const properties = descriptorMapProperties(map);
  if (properties === null || !isUnshadowedLibGlobal(callee.expression, admission.isLibOnlyBinding)) return null;
  return properties;
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
