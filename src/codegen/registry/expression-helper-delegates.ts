// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6774 / #6797) Late-bound helpers for the standalone expression leaves in
// src/codegen/expressions/ (new-target-value, eval-param-scope-hoist,
// eval-spread-args, tagged-template-standalone, with-call-binding). Those
// leaves are value-imported by the big codegen SCC (calls.ts, closures.ts,
// string-ops.ts, …); a value import back into an SCC module would pull each
// leaf into the import cycle that check-import-cycles ratchets. Each owning
// module registers its function here at module scope (the shared.ts pattern),
// and this file imports types only, so it stays an acyclic sink.
import type * as LateImports from "../expressions/late-imports.js";
import type * as EvalInline from "../expressions/eval-inline.js";
import type * as IteratorNative from "../iterator-native.js";
import type * as ObjectRuntime from "../object-runtime.js";
import type * as WithScope from "../with-scope.js";

interface ExpressionHelpers {
  emitUndefined: typeof LateImports.emitUndefined;
  emitStandaloneIndirectEvalRuntime: typeof EvalInline.emitStandaloneIndirectEvalRuntime;
  foldedEvalDeclarationNames: typeof EvalInline.foldedEvalDeclarationNames;
  resolveConstantString: typeof EvalInline.resolveConstantString;
  ensureNativeArrayFromIterN: typeof IteratorNative.ensureNativeArrayFromIterN;
  ensureObjVecBuilders: typeof ObjectRuntime.ensureObjVecBuilders;
  reserveApplyClosure: typeof ObjectRuntime.reserveApplyClosure;
  emitCaptureWithHasBinding: typeof WithScope.emitCaptureWithHasBinding;
  resolveWithBinding: typeof WithScope.resolveWithBinding;
}

const registered: Partial<ExpressionHelpers> = {};

/** Called at module scope by each owning module with the helpers it implements. */
export function registerExpressionHelpers(helpers: Partial<ExpressionHelpers>): void {
  Object.assign(registered, helpers);
}

function helper<K extends keyof ExpressionHelpers>(name: K): ExpressionHelpers[K] {
  const fn = registered[name];
  if (fn === undefined)
    throw new Error(`codegen helper "${name}" not yet registered (its owning module was not loaded)`);
  return fn;
}

export const emitUndefined: ExpressionHelpers["emitUndefined"] = (...a) => helper("emitUndefined")(...a);
export const emitStandaloneIndirectEvalRuntime: ExpressionHelpers["emitStandaloneIndirectEvalRuntime"] = (...a) =>
  helper("emitStandaloneIndirectEvalRuntime")(...a);
export const foldedEvalDeclarationNames: ExpressionHelpers["foldedEvalDeclarationNames"] = (...a) =>
  helper("foldedEvalDeclarationNames")(...a);
export const resolveConstantString: ExpressionHelpers["resolveConstantString"] = (...a) =>
  helper("resolveConstantString")(...a);
export const ensureNativeArrayFromIterN: ExpressionHelpers["ensureNativeArrayFromIterN"] = (...a) =>
  helper("ensureNativeArrayFromIterN")(...a);
export const ensureObjVecBuilders: ExpressionHelpers["ensureObjVecBuilders"] = (...a) =>
  helper("ensureObjVecBuilders")(...a);
export const reserveApplyClosure: ExpressionHelpers["reserveApplyClosure"] = (...a) =>
  helper("reserveApplyClosure")(...a);
export const emitCaptureWithHasBinding: ExpressionHelpers["emitCaptureWithHasBinding"] = (...a) =>
  helper("emitCaptureWithHasBinding")(...a);
export const resolveWithBinding: ExpressionHelpers["resolveWithBinding"] = (...a) => helper("resolveWithBinding")(...a);
