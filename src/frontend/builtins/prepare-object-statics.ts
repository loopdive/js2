// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import { makeIrAmbientBindingPredicate, makeIrPrimitiveExpressionClassifier } from "../../ir/module-bindings.js";
import { objectStaticCallPlan, type ObjectStaticPlan, type ObjectStaticsRealm } from "../../ir/object-statics.js";
import { isUnshadowedLibBinding } from "../../shared/ambient-intrinsics.js";
import { sourceRunsDynamicCode } from "../../shared/intrinsic-prototype-writes.js";

/**
 * (#7368) The Prepared program's lane of the `Object` statics table (`ir/object-statics.ts`). The table stays the one
 * admission; this resolver answers what it asks of the lane and the program, since the Prepared path has no selector:
 *   - the lane is standalone WasmGC, whose realm serves a static through the `js.object.*` contracts;
 *   - `Object` is ambient where the checker binds the identifier to the lib declarations alone and no source
 *     declares the name;
 *   - dynamic code may run only where a source spells a route to it (the program is closed);
 *   - no other arm takes an own-property test here, so the fallback test row has all of its territory.
 */
export function prepareObjectStaticsResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  isDynamicModuleBinding: (identifier: ts.Identifier) => boolean,
): { readonly preparedObjectStaticPlan: (call: ts.CallExpression) => ObjectStaticPlan | undefined } {
  const isLibOnlyBinding = makeIrAmbientBindingPredicate(checker, "every");
  const realm: ObjectStaticsRealm = {
    isAmbientBinding: (node) => isUnshadowedLibBinding(node, isLibOnlyBinding),
    dynamicCodeMayRun: sourceFiles.some(sourceRunsDynamicCode),
    supportsBackendCapability: () => true,
    isDynamicModuleBinding,
    existingArmAdmits: () => false,
    classifyPrimitive: makeIrPrimitiveExpressionClassifier(checker),
  };
  return {
    preparedObjectStaticPlan: (call) =>
      sourceFiles.includes(call.getSourceFile()) ? objectStaticCallPlan(call, realm) : undefined,
  };
}
