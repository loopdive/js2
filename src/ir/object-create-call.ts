// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7276) `Object.create({}, { <key>: { <data fields> }, … })` in a JS
 * environment under the native regime, as one IR lowering admitted by ONE
 * plan that the selector and from-ast both read. On host-free standalone the
 * `Object` statics table (`object-statics.ts`) owns this call; this module
 * keeps the JS environment's output unchanged until that environment adopts
 * the table.
 *
 * Legacy expands the descriptor map at compile time (`call-builtin-static.ts`,
 * the `Object.create` arm): `__object_create(<proto $Object>)`, then one
 * define per key. The IR takes legacy's other arm, the #7128 open-carrier
 * define, `__obj_define_from_desc` over a descriptor `$Object`, so no flag
 * encoding is duplicated. The object crosses onto the dynamic carrier.
 *
 * Admitted, so that the definition order and every descriptor are fixed at
 * compile time:
 *   - the proto is the empty literal `{}`;
 *   - the map is a literal descriptor map (`descriptorMapDefinitions`) whose
 *     every value is a primitive literal;
 *   - every `in` of the enclosing unit is an own-key probe
 *     (`unitInKeysAreOwnOnly`).
 */

import { isUnshadowedLibBinding } from "../shared/ambient-intrinsics.js";
import { ts } from "../ts-api.js";
import type { IrBackendTargetCapability } from "./backend/legality.js";
import type { IrFunctionBuilder } from "./builder.js";
import {
  descriptorMapDefinitions,
  isPrimitiveLiteral,
  unitInKeysAreOwnOnly,
  type DescriptorDefinition,
} from "./empty-object-literal.js";
import { irDynamic, irVal, type IrValueId } from "./nodes.js";
import {
  emitNewPlainObject,
  emitObjectRuntimeCall,
  emitOpenCarrierDefine,
  type ObjectStaticDefinitionValues,
} from "./open-object-carrier.js";

/** What both sides ask of their lane and binding resolver. */
export interface IrObjectCreateAdmission {
  /** The lane: the native regime's member read, off the statics table's lane (see `legality.ts`). */
  readonly supportsBackendCapability: (
    capability: Extract<IrBackendTargetCapability, "native-dynamic-member-read" | "native-object-statics">,
  ) => boolean;
  /** The lib-only binding test — a script `function Object() {}` merges with the lib's. */
  readonly isLibOnlyBinding: (node: ts.Identifier) => boolean;
}

/** The admitted call's definitions, else null. Read by the selector and by from-ast. */
export function objectCreateDescriptorMap(
  expr: ts.CallExpression,
  admission: IrObjectCreateAdmission,
): readonly DescriptorDefinition[] | null {
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
  if (
    !admission.supportsBackendCapability("native-dynamic-member-read") ||
    admission.supportsBackendCapability("native-object-statics")
  ) {
    return null;
  }
  const definitions = descriptorMapDefinitions(expr.arguments[1]!, isPrimitiveLiteral);
  if (definitions === null || !isUnshadowedLibBinding(callee.expression, admission.isLibOnlyBinding)) return null;
  return unitInKeysAreOwnOnly(expr) ? definitions : null;
}

/** What the lowering needs from from-ast (no import of the lowerer itself). */
export interface ObjectCreateLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly admission: IrObjectCreateAdmission;
  /** A definition's literal field values, boxed onto the dynamic carrier. */
  readonly lowerDefinition: (definition: DescriptorDefinition) => ObjectStaticDefinitionValues;
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
  const definitions = objectCreateDescriptorMap(expr, host.admission);
  if (definitions === null) return null;
  const { builder } = host;
  const externref = irVal({ kind: "externref" });
  const proto = emitNewPlainObject(builder, externref);
  const object = emitObjectRuntimeCall(builder, "__object_create", [proto], externref);
  for (const definition of definitions) emitOpenCarrierDefine(builder, object, host.lowerDefinition(definition));
  return builder.emitBox(object, irDynamic());
}
