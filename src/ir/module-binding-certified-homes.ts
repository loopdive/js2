// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The script-var homes whose binding rests on certified writes (#7252's class
 * instance, #7292's string vec, #7106 lever S2's `exec` match result, whose
 * writes legacy's #1914 inference proved), dispatched by home: the value kind
 * each binds as, whether a write matches it, and where a use may read it. The
 * resolver (`module-bindings.ts`) asks here; each certifier owns its own rule, over the
 * shared source facts in `module-binding-script-var.ts`. The `string` home is
 * not write-certified, so the resolver keeps its arm; capability-certified
 * (#7274) bindings only share the declaration-order use rule here.
 */
import { ts } from "../ts-api.js";
import { classInstanceValueKind, classInstanceWriteMatches } from "./module-binding-class-instance.js";
import { scriptVarUseFollowsDeclaration } from "./module-binding-script-var.js";
import type { IrModuleBindingValueKind, IrScriptVarHome } from "./module-binding-value-kinds.js";
import { vecUseSupported, vecValueKind, vecWriteMatches } from "./module-binding-vec.js";
import { regExpMatchUseSupported, regExpMatchWriteMatches, type ClassifyPrimitive } from "./regexp-match-uses.js";

type ScriptVarDeclaration = ts.VariableDeclaration | ts.BindingElement;

/** The kind a certified home binds as, or `undefined` (another home, or its writes are not certified). */
export function certifiedScriptVarKind(
  home: IrScriptVarHome | undefined,
  checker: ts.TypeChecker,
  declaration: ScriptVarDeclaration,
  declaredType: ts.Type,
): IrModuleBindingValueKind | undefined {
  if (home === "class-instance") return classInstanceValueKind(checker, declaration, declaredType);
  if (home === "vec") return vecValueKind(checker, declaration);
  // Legacy's #1914 inference proved every write a match result: no checker agreement to ask.
  return home === "regexp-match" ? { kind: "regexp-match" } : undefined;
}

/** Whether `value` is a write a certified kind takes; `undefined` for any other kind. */
export function certifiedScriptVarWriteMatches(
  checker: ts.TypeChecker,
  declaration: ScriptVarDeclaration,
  kind: IrModuleBindingValueKind,
  value: ts.Expression,
): boolean | undefined {
  if (kind.kind === "class-instance") return classInstanceWriteMatches(checker, kind, value);
  if (kind.kind === "vec") return vecWriteMatches(declaration, value);
  return kind.kind === "regexp-match" ? regExpMatchWriteMatches(value) : undefined;
}

/**
 * Whether `node` may read a binding of `kind`: a certified handle (a class
 * instance, or #7274's provider-certified extern, `capabilityCertified`) only
 * where its slot is already written, a vec or a match result only in a use
 * its IR lowering reads as legacy does. Every other kind is not certified by
 * its writes, so any use reads it.
 */
export function certifiedScriptVarUse(
  kind: IrModuleBindingValueKind,
  capabilityCertified: boolean,
  node: ts.Identifier,
  declaration: ScriptVarDeclaration,
  classify: ClassifyPrimitive,
): boolean {
  if (kind.kind === "vec") return vecUseSupported(node, declaration);
  if (kind.kind === "regexp-match") return regExpMatchUseSupported(node, declaration, classify);
  const certified = capabilityCertified || kind.kind === "class-instance";
  return !certified || scriptVarUseFollowsDeclaration(node, declaration);
}
