// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7352 A2) The carrier kinds a script `var`'s dynamic home can hold, read from its writes (`scriptVarWrites`, the
 * write classifier every script-var home shares). The home holds the hoisted `undefined` and each value written into
 * it, so when every write is a literal whose kind its syntax names, that set is exact: the dynamic-value
 * legalization needs no arm for another kind (`kindsOf`).
 *
 * Every write must be visible, so the fact is dropped (every kind) where one may not be:
 *   - `with` or a direct `eval` (`scriptVarWrites` declines);
 *   - code the source does not spell: `eval` by any route, `Function` (`sourceRunsDynamicCode`);
 *   - the global object escaping (`this`, `globalThis`: `sourceMayWriteGlobalObject`);
 *   - the binding's name stored, deleted or defined other than by its declaration (`this.a = v`, `delete a`, `a = v`:
 *     `sourceWritesMemberNamed`).
 * A closure's write is a write of the binding's symbol, which `scriptVarWrites` reads like any other.
 */
import { ts } from "../ts-api.js";
import { scriptVarWrites } from "./module-binding-script-var.js";
import { stripParens } from "../shared/binding-writes.js";
import {
  sourceMayWriteGlobalObject,
  sourceRunsDynamicCode,
  sourceWritesMemberNamed,
} from "../shared/intrinsic-prototype-writes.js";
import type { CarrierKind } from "./program/dynamic-value-kinds.js";
import type { IrType } from "./core/types.js";
import type { IrGlobalRef } from "./core/value-references.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";

/**
 * The kinds the dynamic home of the script var `declaration` holds, or `undefined` for every kind. An object or
 * array literal is the object kind: the Prepared path builds each literal it owns as an ordinary object or an Array.
 */
function scriptVarKinds(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
): readonly CarrierKind[] | undefined {
  const file = declaration.getSourceFile();
  if (
    !ts.isIdentifier(declaration.name) ||
    sourceRunsDynamicCode(file) ||
    sourceMayWriteGlobalObject(file) ||
    sourceWritesMemberNamed(file, declaration.name.text)
  )
    return undefined;
  const objects = scriptVarWrites(checker, declaration)?.every((write) => {
    const value = write.kind === "value" ? stripParens(write.expr) : undefined;
    return value !== undefined && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value));
  });
  return objects === true ? HOLDS_OBJECTS : undefined;
}

/** The hoisted `undefined`, then the objects written. */
const HOLDS_OBJECTS: readonly CarrierKind[] = Object.freeze(["undefined", "object"]);

/** The kinds of each dynamic script var among a program's `globals`, by the binding its reads name. */
export function scriptVarGlobalKinds(
  checker: ts.TypeChecker,
  globals: ReadonlyMap<
    ts.Declaration,
    { readonly binding: { readonly type: IrType; readonly globalRef: IrGlobalRef } }
  >,
): ReadonlyMap<IrBindingId, readonly CarrierKind[]> {
  const kinds = new Map<IrBindingId, readonly CarrierKind[]>();
  for (const [declaration, { binding }] of globals) {
    const held =
      binding.type.kind === "dynamic" && ts.isVariableDeclaration(declaration)
        ? scriptVarKinds(checker, declaration)
        : undefined;
    if (held) kinds.set(binding.globalRef.binding.bindingId, held);
  }
  return kinds;
}
