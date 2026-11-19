// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 Ty) Which provider resolves an identifier read, in from-ast's resolution order. The ONE authority for
 * that order: the identifier read lowers by switching on the answer, and every other question about a read (the
 * `typeof` of a name nothing resolves) asks the same function, so the two cannot drift. It emits nothing (it throws
 * only on a DOM preparation mismatch).
 */
import ts from "typescript";
import { isAmbientIntrinsicValueUse } from "../shared/ambient-intrinsics.js";
import { IrInvariantError } from "./outcomes.js";
import type { IrFromAstResolver } from "./from-ast.js";
import type { FunctionValueLoweringPlans } from "./function-object-lowering.js";

type ModuleBinding = NonNullable<ReturnType<NonNullable<IrFromAstResolver["resolveModuleBinding"]>>>;
type HostGlobal = NonNullable<ReturnType<NonNullable<IrFromAstResolver["getHostGlobalInfo"]>>>;
type TopLevelFunction = NonNullable<
  ReturnType<NonNullable<FunctionValueLoweringPlans["topLevelFunctionValues"]>["get"]>
>;

export type IdentifierRead<Binding> =
  | { readonly kind: "top-level-function"; readonly plan: TopLevelFunction }
  | { readonly kind: "scope"; readonly binding: Binding }
  | { readonly kind: "module-binding"; readonly binding: ModuleBinding }
  /** The global `undefined` as a value: the carrier's undefined (#7106 item 1). */
  | { readonly kind: "global-undefined" }
  /** `NaN` / `Infinity` (#7104, legacy's `identifiers.ts` arm). */
  | { readonly kind: "global-number"; readonly value: number }
  /** A host ambient global (`document`, …) through the declared-globals registry (#2856). */
  | { readonly kind: "host-global"; readonly global: HostGlobal; readonly certifiedDom: boolean }
  /** An ambient intrinsic as a value, read off the realm's global object (#7106). */
  | { readonly kind: "ambient-intrinsic" }
  /**
   * (#7354 Ty) A `typeof` operand no provider resolves, where the resolver states the name is absent from this
   * program's global environment: its `typeof` is "undefined" (§13.5.3, an unresolvable reference).
   */
  | { readonly kind: "absent-global" }
  | { readonly kind: "unresolved" };

interface IdentifierReadContext<Binding> extends FunctionValueLoweringPlans {
  readonly scope: ReadonlyMap<string, Binding>;
  readonly resolver?: IrFromAstResolver;
  readonly funcName: string;
}

export function classifyIdentifierRead<Binding>(
  expr: ts.Identifier,
  cx: IdentifierReadContext<Binding>,
): IdentifierRead<Binding> {
  const plan = cx.topLevelFunctionValues?.get(expr);
  if (plan) return { kind: "top-level-function", plan };
  const binding = cx.scope.get(expr.text);
  // Scope bindings take priority: a local named `document` or `undefined` shadows the global.
  if (binding !== undefined) return { kind: "scope", binding };
  const resolver = cx.resolver;
  const moduleBinding = resolver?.resolveModuleBinding?.(expr);
  if (moduleBinding) return { kind: "module-binding", binding: moduleBinding };
  // Selector-admitted on the dynamic host-free lanes only.
  if (expr.text === "undefined" && resolver?.stringIsExternref?.() !== true) return { kind: "global-undefined" };
  if (expr.text === "NaN" || expr.text === "Infinity")
    return { kind: "global-number", value: expr.text === "NaN" ? NaN : Infinity };
  const dom = resolver?.standaloneDomOperation?.(expr);
  const global = resolver?.getHostGlobalInfo?.(expr.text);
  if (dom?.kind === "global-get" && !global)
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      `ir/from-ast: certified DOM global ${expr.text} has no prepared import (${cx.funcName})`,
    );
  if (global)
    return {
      kind: "host-global",
      global,
      certifiedDom: dom?.kind === "global-get" && dom.identifier === expr && dom.importName === global.importName,
    };
  if (isAmbientIntrinsicValueUse(expr, (node) => resolver?.isLibOnlyBinding?.(node) === true, resolver))
    return { kind: "ambient-intrinsic" };
  return absentTypeofOperand(expr, (node) => resolver?.unresolvedNameIsAbsent?.(node) === true)
    ? { kind: "absent-global" }
    : { kind: "unresolved" };
}

/**
 * The `absent-global` question once every earlier arm declined: `expr` is a `typeof` operand (through parentheses)
 * and `isAbsent` (the resolver's `unresolvedNameIsAbsent`) says the program's environment lacks it. Also asked
 * without a lowering context, to decide whether a root needs the dynamic legalization; there the earlier arms are
 * not asked, so `typeof undefined` counts too, which only legalizes a function that then has nothing to legalize.
 */
export function absentTypeofOperand(expr: ts.Identifier, isAbsent: (node: ts.Identifier) => boolean): boolean {
  let node: ts.Node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return ts.isTypeOfExpression(node.parent) && isAbsent(expr);
}
