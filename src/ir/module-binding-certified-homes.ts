// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The script-var homes whose binding rests on certified writes (#7252's class
 * instance, #7292's string vec), dispatched by home: the value kind each binds
 * as, whether a write matches it, and where a use may read it. The resolver
 * (`module-bindings.ts`) asks here; each certifier owns its own rule, over the
 * shared source facts in `module-binding-script-var.ts`. The `string` home is
 * not write-certified, so the resolver keeps its arm; capability-certified
 * (#7274) bindings only share the declaration-order use rule here.
 */
import { ts } from "../ts-api.js";
import { classInstanceValueKind, classInstanceWriteMatches } from "./module-binding-class-instance.js";
import { scriptVarUseFollowsDeclaration } from "./module-binding-script-var.js";
import type { IrModuleBindingValueKind, IrScriptVarHome } from "./module-binding-value-kinds.js";
import { vecUseSupported, vecValueKind, vecWriteMatches } from "./module-binding-vec.js";

type ScriptVarDeclaration = ts.VariableDeclaration | ts.BindingElement;

/** The kind a certified home binds as, or `undefined` (another home, or its writes are not certified). */
export function certifiedScriptVarKind(
  home: IrScriptVarHome | undefined,
  checker: ts.TypeChecker,
  declaration: ScriptVarDeclaration,
  declaredType: ts.Type,
): IrModuleBindingValueKind | undefined {
  if (home === "class-instance") return classInstanceValueKind(checker, declaration, declaredType);
  return home === "vec" ? vecValueKind(checker, declaration) : undefined;
}

/** Whether `value` is a write a certified kind takes; `undefined` for any other kind. */
export function certifiedScriptVarWriteMatches(
  checker: ts.TypeChecker,
  declaration: ScriptVarDeclaration,
  kind: IrModuleBindingValueKind,
  value: ts.Expression,
): boolean | undefined {
  if (kind.kind === "class-instance") return classInstanceWriteMatches(checker, kind, value);
  return kind.kind === "vec" ? vecWriteMatches(declaration, value) : undefined;
}

/**
 * Whether `node` may read a binding of `kind`: a certified handle (a class
 * instance, or #7274's provider-certified extern, `capabilityCertified`) only
 * where its slot is already written, a vec only in a use the IR vec lowers.
 * Every other kind is not certified by its writes, so any use reads it.
 */
export function certifiedScriptVarUse(
  kind: IrModuleBindingValueKind,
  capabilityCertified: boolean,
  node: ts.Identifier,
  declaration: ScriptVarDeclaration,
): boolean {
  if (kind.kind === "vec") return vecUseSupported(node, declaration);
  const certified = capabilityCertified || kind.kind === "class-instance";
  return !certified || scriptVarUseFollowsDeclaration(node, declaration);
}
