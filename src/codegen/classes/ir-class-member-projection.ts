// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrClassShape } from "../../ir/nodes.js";
import { ts } from "../../ts-api.js";

/**
 * (#7233) May `buildIrClassShapes` skip an unprojectable instance method of a
 * class in `sourceFile`, leaving that one method on its legacy body and slot,
 * instead of dropping the whole class? JS sources only (`NodeFlags.
 * JavaScriptFile`), so typed classes keep their all-or-nothing shapes and
 * bytes. Never when an ancestor shape carries a member of the same name: the
 * IR's inherited-member walk would otherwise reach the ancestor descriptor for
 * a name the skipped override shadows.
 *
 * An ancestor method that was itself skipped has no descriptor, so this walk
 * does not see it. That is safe: a call through that name finds no descriptor
 * on either class (the selector stops at the own unprojected member), so both
 * sides stay on their legacy bodies.
 */
export function irJsInstanceMethodMaySkip(
  sourceFile: ts.SourceFile,
  parentShape: IrClassShape | undefined,
  name: string,
): boolean {
  if ((sourceFile.flags & ts.NodeFlags.JavaScriptFile) === 0) return false;
  for (let shape = parentShape; shape; shape = shape.parent) {
    if (shape.methods.some((m) => m.name === name) || shape.fields.some((f) => f.name === name)) return false;
  }
  return true;
}
